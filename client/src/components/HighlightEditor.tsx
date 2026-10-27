import { t, useLocale } from "../i18n";
import {useState} from 'react';
import {useMutation,useQueryClient} from '@tanstack/react-query';
import {Alert,Button,Input,InputNumber,message} from 'antd';
import {RotateCcw,RotateCw,Scissors,X} from 'lucide-react';
import {requestJson} from '../lib/http';
import './highlights.css';
const time=(value:number)=>`${Math.floor(value/3600)?`${Math.floor(value/3600)}:`:''}${String(Math.floor(value/60)%60).padStart(2,'0')}:${String(Math.floor(value%60)).padStart(2,'0')}`;
const json=(body:unknown)=>({method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
export function HighlightEditor({mediaId,sourceTitle,position,duration,onSeek,onClose}:{mediaId:string;sourceTitle:string;position:number;duration:number;onSeek:(time:number)=>void;onClose:()=>void}){
  useLocale();
 const [start,setStart]=useState(Math.max(0,Math.floor(position)));const [end,setEnd]=useState(Math.min(duration,Math.floor(position)+30));const [title,setTitle]=useState(t("{{p0}} · 高光", { p0: sourceTitle }).slice(0,100));const cache=useQueryClient();
 const save=useMutation({mutationFn:()=>requestJson('/api/highlights',json({mediaId,title:title.trim(),start,end})),onSuccess:()=>{void cache.invalidateQueries({queryKey:['highlights']});message.success(t("已加入生成队列，可在“我的高光”查看"));onClose();}});
 const valid=title.trim().length>0&&end>start&&end-start>=1&&end-start<=1800&&end<=duration;
 return <section className="highlight-editor" aria-label={t("截取高光片段")} onKeyDown={event=>{event.stopPropagation();if(event.key==='Escape')onClose();}}>
  <header><strong><Scissors size={17}/>{t("截取高光")}</strong><button type="button" aria-label={t("关闭高光编辑")} onClick={onClose}><X size={20}/></button></header>
  <label className="highlight-name">{t("名称")}<Input value={title} maxLength={100} onChange={e=>setTitle(e.target.value)}/></label>
  <div className="highlight-seek" aria-label={t("寻找高光位置")}>
   <Button aria-label={t("后退 10 秒")} icon={<RotateCcw size={16}/>} disabled={position<=0} onClick={()=>onSeek(Math.max(0,position-10))}>{t("10 秒")}</Button>
   <div><small>{t("当前播放位置")}</small><output aria-label={t("当前播放位置")}>{time(position)}.{Math.floor(position*10)%10}</output></div>
   <Button aria-label={t("前进 10 秒")} icon={<RotateCw size={16}/>} disabled={position>=duration} onClick={()=>onSeek(Math.min(duration,position+10))}>{t("10 秒")}</Button>
  </div>
  <div className="highlight-marks">
   <label>{t("开始（秒）")}<InputNumber aria-label={t("高光开始时间（秒）")} min={0} max={duration} step={0.1} value={start} onChange={v=>setStart(v??0)}/><Button onClick={()=>setStart(Math.round(position*10)/10)}>{t("设为起点")}</Button></label>
   <label>{t("结束（秒）")}<InputNumber aria-label={t("高光结束时间（秒）")} min={0} max={duration} step={0.1} value={end} onChange={v=>setEnd(v??0)}/><Button onClick={()=>setEnd(Math.round(position*10)/10)}>{t("设为终点")}</Button></label>
  </div>
  <div className="highlight-duration" aria-live="polite"><span>{t("已选片段时长")}</span><output aria-label={t("已选片段时长")}>{end>=start ? t("{{p0}} 秒", { p0: (end-start).toFixed(1) }) : t("结束时间须晚于开始时间")}</output></div>
  <small className="highlight-hint" title={t("保存为独立片段，存放在外接硬盘，不修改原影片")}>{t("1 秒–30 分钟 · 保存至外接硬盘")}</small>
  {save.error&&<Alert type="error" title={save.error.message}/>}
  <footer><Button disabled={!valid||save.isPending} onClick={()=>onSeek(start)}>{t("定位起点")}</Button><Button type="primary" disabled={!valid} loading={save.isPending} onClick={()=>save.mutate()}>{t("保存片段")}</Button></footer>
 </section>;
}
