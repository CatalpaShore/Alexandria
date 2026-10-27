import type { ThemeConfig } from "antd";

export const appTheme: ThemeConfig = {
  token: {
    borderRadius: 8,
    colorBgBase: "#0b0b0b",
    colorBgContainer: "#171717",
    colorBgElevated: "#202020",
    colorBorder: "#323232",
    colorBorderSecondary: "#262626",
    colorFillSecondary: "#232323",
    colorFillTertiary: "#1b1b1b",
    colorError: "#ff6b73",
    colorErrorBg: "#2b1215",
    colorErrorBorder: "#78333a",
    colorErrorText: "#ffb0b5",
    colorInfo: "#ff9900",
    colorInfoBg: "#211907",
    colorInfoBorder: "#6c4a0c",
    colorInfoText: "#ffd083",
    colorLink: "#ff9900",
    colorPrimary: "#ff9900",
    colorPrimaryBg: "#2a210f",
    colorPrimaryBgHover: "#332713",
    colorPrimaryHover: "#ffae2b",
    colorPrimaryActive: "#e48500",
    colorSuccess: "#21b981",
    colorSuccessBg: "#10251d",
    colorSuccessBorder: "#28634c",
    colorSuccessText: "#9aebc7",
    colorText: "#f4f4f4",
    colorTextDisabled: "#969696",
    colorTextSecondary: "#b8b8b8",
    colorTextTertiary: "#8a8a8a",
    colorWarning: "#ffad33",
    colorWarningBg: "#2a1d09",
    colorWarningBorder: "#77500d",
    colorWarningText: "#ffd083",
    colorBgContainerDisabled: "#1b1b1b",
    controlItemBgActive: "#2a210f",
    controlItemBgActiveHover: "#332713",
    controlItemBgActiveDisabled: "#242018",
    motionDurationFast: "0.14s",
    motionDurationMid: "0.18s",
    motionDurationSlow: "0.24s",
    motionEaseInOut: "cubic-bezier(.2, .75, .25, 1)",
    fontFamily:
      "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
  },
  components: {
    Button: {
      defaultBg: "#1c1c1c",
      defaultBorderColor: "#343434",
      defaultColor: "#f2f2f2",
      defaultHoverBg: "#252525",
      defaultHoverBorderColor: "#ff9900",
      defaultHoverColor: "#ffb340",
      primaryShadow: "0 8px 20px rgb(255 153 0 / 22%)"
    },
    Card: {
      colorBgContainer: "#171717",
      headerBg: "#171717"
    },
    Drawer: {
      colorBgElevated: "#151515"
    },
    Input: {
      activeBg: "#101010",
      activeBorderColor: "#ff9900",
      colorBgContainer: "#101010",
      hoverBg: "#141414",
      hoverBorderColor: "#ff9900"
    },
    Layout: { bodyBg: "#0b0b0b", headerBg: "#0b0b0b", siderBg: "transparent" },
    Menu: {
      itemDisabledColor: "#969696"
    },
    Segmented: {
      itemActiveBg: "#ff9900",
      itemColor: "#b8b8b8",
      itemHoverBg: "#242424",
      itemHoverColor: "#ffffff",
      itemSelectedBg: "#ff9900",
      itemSelectedColor: "#0b0b0b",
      trackBg: "#101010"
    },
    Select: {
      activeBorderColor: "#ff9900",
      colorBgContainer: "#101010",
      colorBgElevated: "#202020",
      optionActiveBg: "#2a210f",
      optionSelectedBg: "#ff9900",
      optionSelectedColor: "#0b0b0b"
    },
    Table: {
      rowSelectedBg: "#2a210f",
      rowSelectedHoverBg: "#332713"
    },
    Tag: {
      defaultBg: "#242424",
      defaultColor: "#e8e8e8"
    }
  }
};
