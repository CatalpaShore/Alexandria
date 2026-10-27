#!/bin/bash

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
LOG_DIR="$PROJECT_ROOT/.local/data/logs"
RUN_DIR="$PROJECT_ROOT/.local/data/run"
STDOUT_LOG="$LOG_DIR/media-wall-service.log"
STDERR_LOG="$LOG_DIR/media-wall-service.error.log"
SUPERVISOR_PID_FILE="$RUN_DIR/media-wall-supervisor.pid"
SERVER_PID_FILE="$RUN_DIR/media-wall-server.pid"
SUPERVISOR_LOCK="$RUN_DIR/media-wall-supervisor.lock"
SERVICE_PORT="${AMW_SERVICE_PORT:-4310}"
SERVICE_URL="http://127.0.0.1:$SERVICE_PORT"

# Removed automatically when upgrading from the older LaunchAgent implementation.
LEGACY_LABEL="org.alexandria.public-media-wall"
LEGACY_PLIST="$HOME/Library/LaunchAgents/$LEGACY_LABEL.plist"
LEGACY_DOMAIN="gui/$(id -u)"

info() {
  printf '[Alexandria 18+] %s\n' "$*"
}

fail() {
  printf '[Alexandria 18+] 错误：%s\n' "$*" >&2
  exit 1
}

resolve_runtime() {
  if [ -n "${AMW_NODE_BIN:-}" ]; then
    NODE_BIN="$AMW_NODE_BIN"
  else
    NODE_BIN="$(command -v node 2>/dev/null || true)"
  fi
  [ -x "$NODE_BIN" ] || fail "未找到 Node.js，请先在当前终端启用 Node 22。"

  NODE_MAJOR="$($NODE_BIN -p 'process.versions.node.split(".")[0]')"
  [ "$NODE_MAJOR" -ge 22 ] || fail "需要 Node.js 22 或更高版本，当前为 $($NODE_BIN --version)。"

  if [ -n "${AMW_COREPACK_BIN:-}" ]; then
    COREPACK_BIN="$AMW_COREPACK_BIN"
  elif [ -x "$(dirname "$NODE_BIN")/corepack" ]; then
    COREPACK_BIN="$(dirname "$NODE_BIN")/corepack"
  else
    COREPACK_BIN="$(command -v corepack 2>/dev/null || true)"
  fi
  [ -x "$COREPACK_BIN" ] || fail "未找到与 Node.js 配套的 corepack。"
}

read_pid_file() {
  local file="$1"
  if [ -f "$file" ]; then
    tr -cd '0-9' <"$file"
  fi
}

pid_is_running() {
  local pid="${1:-}"
  [ -n "$pid" ] && kill -0 "$pid" >/dev/null 2>&1
}

supervisor_is_running() {
  local pid cwd
  pid="$(read_pid_file "$SUPERVISOR_PID_FILE")"
  pid_is_running "$pid" || return 1
  [ -d "$SUPERVISOR_LOCK" ] || return 1
  cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1)"
  [ "$cwd" = "$PROJECT_ROOT" ]
}

listener_pids() {
  lsof -nP -tiTCP:"$SERVICE_PORT" -sTCP:LISTEN 2>/dev/null || true
}

assert_port_available() {
  local pids
  pids="$(listener_pids)"
  if [ -n "$pids" ]; then
    fail "端口 $SERVICE_PORT 已被 PID ${pids//$'\n'/, } 占用。请先停止占用该端口的进程。"
  fi
}

wait_for_health() {
  local attempt
  for attempt in $(seq 1 90); do
    if curl -fsS --max-time 2 "$SERVICE_URL/api/health" >/dev/null 2>&1; then
      info "服务已就绪：${SERVICE_URL}"
      return 0
    fi
    sleep 1
  done
  printf '[Alexandria 18+] 服务未在预期时间内通过健康检查。最近错误日志：\n' >&2
  tail -n 40 "$STDERR_LOG" 2>/dev/null >&2 || true
  return 1
}

wait_for_supervisor_exit() {
  local pid="$1" attempt
  for attempt in $(seq 1 100); do
    pid_is_running "$pid" || return 0
    sleep 0.1
  done
  return 1
}

cleanup_legacy_launchagent() {
  if launchctl print "$LEGACY_DOMAIN/$LEGACY_LABEL" >/dev/null 2>&1; then
    launchctl bootout "$LEGACY_DOMAIN/$LEGACY_LABEL" >/dev/null 2>&1 || true
  fi
  if [ -f "$LEGACY_PLIST" ]; then
    if rm -f "$LEGACY_PLIST" 2>/dev/null; then
      info "已移除无法访问 Documents 的旧 LaunchAgent。"
    else
      info "旧 LaunchAgent 已卸载，但当前终端无权删除 ${LEGACY_PLIST}；它不会再运行。"
    fi
  fi
}

build_app() {
  resolve_runtime
  [ -d "$PROJECT_ROOT/node_modules" ] || fail "依赖尚未安装，请先运行 corepack pnpm install。"
  info "构建正式版本……"
  (cd "$PROJECT_ROOT" && "$COREPACK_BIN" pnpm build)
}

start_service() {
  resolve_runtime
  cleanup_legacy_launchagent
  mkdir -p "$LOG_DIR" "$RUN_DIR"

  if supervisor_is_running; then
    if curl -fsS --max-time 2 "$SERVICE_URL/api/health" >/dev/null 2>&1; then
      info "正式服务已在运行：${SERVICE_URL}"
      return
    fi
    info "监督器已启动，正在等待服务就绪……"
    wait_for_health
    return
  fi

  rm -f "$SUPERVISOR_PID_FILE" "$SERVER_PID_FILE"
  rmdir "$SUPERVISOR_LOCK" >/dev/null 2>&1 || true
  [ -f "$PROJECT_ROOT/dist/server/index.js" ] || build_app
  assert_port_available

  info "启动脱离终端的正式服务监督器……"
  AMW_NODE_BIN="$NODE_BIN" \
  AMW_COREPACK_BIN="$COREPACK_BIN" \
  AMW_SERVICE_PORT="$SERVICE_PORT" \
  NODE_ENV=production \
  PORT="$SERVICE_PORT" \
    nohup /bin/bash "$PROJECT_ROOT/scripts/alexandria-service.sh" supervise \
      </dev/null >>"$STDOUT_LOG" 2>>"$STDERR_LOG" &
  local supervisor_pid=$!
  disown "$supervisor_pid" >/dev/null 2>&1 || true
  wait_for_health
}

stop_service() {
  cleanup_legacy_launchagent
  local supervisor_pid server_pid
  supervisor_pid="$(read_pid_file "$SUPERVISOR_PID_FILE")"

  if supervisor_is_running; then
    info "正在停止正式服务（监督器 PID ${supervisor_pid}）……"
    kill -TERM "$supervisor_pid"
    if ! wait_for_supervisor_exit "$supervisor_pid"; then
      fail "监督器未能正常退出；为避免误杀进程，请检查：ps -p $supervisor_pid -o command="
    fi
    info "正式服务已停止。"
  else
    server_pid="$(read_pid_file "$SERVER_PID_FILE")"
    if pid_is_running "$server_pid"; then
      fail "发现没有受监督器管理的服务进程 PID ${server_pid}；为避免误杀，未自动停止。"
    fi
    info "正式服务当前未运行。"
  fi

  rm -f "$SUPERVISOR_PID_FILE" "$SERVER_PID_FILE"
  rmdir "$SUPERVISOR_LOCK" >/dev/null 2>&1 || true
}

restart_service() {
  stop_service
  start_service
}

install_service() {
  cleanup_legacy_launchagent
  build_app
  if supervisor_is_running; then
    stop_service
  fi
  start_service
  info "正式服务已由终端脱离会话监督器托管，关闭终端后仍会运行。"
}

show_status() {
  local supervisor_pid server_pid
  supervisor_pid="$(read_pid_file "$SUPERVISOR_PID_FILE")"
  server_pid="$(read_pid_file "$SERVER_PID_FILE")"

  if supervisor_is_running; then
    info "监督器：运行中（PID ${supervisor_pid}）"
  else
    info "监督器：未运行"
  fi
  if pid_is_running "$server_pid"; then
    info "服务进程：运行中（PID ${server_pid}）"
  else
    info "服务进程：未运行"
  fi
  if curl -fsS --max-time 2 "$SERVICE_URL/api/health" >/dev/null 2>&1; then
    info "健康检查：正常（${SERVICE_URL}）"
  else
    info "健康检查：未就绪（${SERVICE_URL}）"
  fi
  info "日志：$STDOUT_LOG"
  info "错误日志：$STDERR_LOG"
}

show_logs() {
  mkdir -p "$LOG_DIR"
  info "按 Ctrl+C 退出日志查看，不会停止服务。"
  touch "$STDOUT_LOG" "$STDERR_LOG"
  tail -n 80 -F "$STDOUT_LOG" "$STDERR_LOG"
}

uninstall_service() {
  stop_service
  cleanup_legacy_launchagent
  info "常驻监督器已移除；正式构建、应用数据和历史日志均保留。"
}

run_supervisor() {
  resolve_runtime
  cd "$PROJECT_ROOT"
  mkdir -p "$LOG_DIR" "$RUN_DIR"
  if ! mkdir "$SUPERVISOR_LOCK" 2>/dev/null; then
    fail "另一个正式服务监督器已经存在。"
  fi

  local child_pid="" stopping="false" exit_code=0
  printf '%s\n' "$$" >"$SUPERVISOR_PID_FILE"

  cleanup() {
    rm -f "$SUPERVISOR_PID_FILE" "$SERVER_PID_FILE"
    rmdir "$SUPERVISOR_LOCK" >/dev/null 2>&1 || true
  }

  shutdown() {
    stopping="true"
    if pid_is_running "$child_pid"; then
      kill -TERM "$child_pid" >/dev/null 2>&1 || true
      wait "$child_pid" 2>/dev/null || true
    fi
    cleanup
    exit 0
  }

  trap shutdown INT TERM
  trap cleanup EXIT

  while [ "$stopping" = "false" ]; do
    "$COREPACK_BIN" pnpm agent:runtime:ensure || \
      printf '[Alexandria 18+] 智能馆长运行时暂未就绪，媒体墙将继续启动。\n' >&2

    "$NODE_BIN" "$PROJECT_ROOT/dist/server/index.js" &
    child_pid=$!
    printf '%s\n' "$child_pid" >"$SERVER_PID_FILE"

    set +e
    wait "$child_pid"
    exit_code=$?
    set -e
    child_pid=""
    rm -f "$SERVER_PID_FILE"

    if [ "$stopping" = "false" ]; then
      printf '[Alexandria 18+] 服务进程退出（code=%s），5 秒后自动重启。\n' "$exit_code" >&2
      sleep 5
    fi
  done
}

show_help() {
  cat <<EOF
用法：corepack pnpm service:<命令>

  service:install   构建并启动正式常驻服务（首次使用）
  service:start     启动正式服务
  service:stop      停止正式服务
  service:restart   重启服务（不会重新构建）
  service:deploy    重新构建并更新正式服务
  service:status    查看监督器和健康状态
  service:logs      持续查看日志；Ctrl+C 只退出查看
  service:uninstall 停止监督器，保留构建、日志和数据

正式服务地址：$SERVICE_URL
EOF
}

case "${1:-start}" in
  install|deploy) install_service ;;
  start) start_service ;;
  stop) stop_service ;;
  restart) restart_service ;;
  status) show_status ;;
  logs) show_logs ;;
  uninstall) uninstall_service ;;
  supervise) run_supervisor ;;
  help|-h|--help) show_help ;;
  *) show_help; exit 2 ;;
esac
