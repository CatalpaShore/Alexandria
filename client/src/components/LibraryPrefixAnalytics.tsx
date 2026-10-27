import { getIntlLocale } from "../i18n/core";
import { t, useLocale, useLocalizedMemo } from "../i18n";
import {useState} from 'react';
import {useMutation,useQuery,useQueryClient} from '@tanstack/react-query';
import {Alert,Button,Drawer,Empty,Input,InputNumber,Modal,Select,Table} from 'antd';
import {ArrowUpRight,Search,Settings2} from 'lucide-react';
import type {PrefixAnalytics,PrefixCollection} from '../../../server/src/libraryPrefixAnalytics';
import type {ActiveEntity} from '../hooks/useOverlayState';
import {fetchPrefixTotals,updatePrefixTotal} from '../lib/libraryAnalyticsApi';
import {prefixCollectionProgress} from '../lib/prefixCollectionProgress';
import {useInfiniteScroll} from '../lib/useInfiniteScroll';
import './library-prefix-analytics.css';

const count=(value:number)=>value.toLocaleString(getIntlLocale());
const percent=(value:number)=>(value*100).toFixed(1)+'%';
const totalsKey=['library-prefix-totals'];
function Ratio({value,numerator,denominator}:{value:number;numerator:number;denominator:number}){
  useLocale();
  return <div className="prefix-ratio"><span><b>{percent(value)}</b><small>{count(numerator)} / {count(denominator)}</small></span><progress max={1} value={Math.min(1,value)} aria-label={`${count(numerator)} / ${count(denominator)}，${percent(value)}`}/></div>;
}

export function LibraryPrefixAnalytics({data,year,onOpenEntity,onShowAllYears}:{data:PrefixAnalytics;year:number|null;onOpenEntity:(entity:ActiveEntity)=>void;onShowAllYears:()=>void}){
  useLocale();
  const queryClient=useQueryClient();
  const totalsQuery=useQuery({queryKey:totalsKey,queryFn:fetchPrefixTotals,staleTime:0});
  const totals=useLocalizedMemo(()=>new Map(totalsQuery.data?.map(item=>[item.prefix,item.total])??[]),[totalsQuery.data]);
  const [search,setSearch]=useState('');const [filter,setFilter]=useState('all');const [visibleCount,setVisibleCount]=useState(24);
  const [selected,setSelected]=useState<string|null>(null);
  const [order,setOrder]=useState('works');const [editing,setEditing]=useState<PrefixCollection|null>(null);const [draft,setDraft]=useState<number|null>(null);
  const save=useMutation({mutationFn:({prefix,total}:{prefix:string;total:number|null})=>updatePrefixTotal(prefix,total),onSuccess:items=>{queryClient.setQueryData(totalsKey,items);setEditing(null);}});
  const progress=(item:PrefixCollection)=>prefixCollectionProgress(item,totals.get(item.prefix),year);
  const visibleItems=useLocalizedMemo(()=>data.items.filter(item=>item.prefix.toUpperCase()!=='FC2'),[data.items]);
  const visibleWorks=data.totalWorks-data.items.filter(item=>item.prefix.toUpperCase()==='FC2').reduce((sum,item)=>sum+item.works,0);
  const rows=useLocalizedMemo(()=>visibleItems.filter(item=>item.prefix.toLowerCase().includes(search.trim().toLowerCase())&&(filter!=='gaps'||item.missingWorks>0)&&(filter!=='held'||item.works>0)&&(filter!=='manual'||totals.has(item.prefix))).sort((a,b)=>{
    const aProgress=prefixCollectionProgress(a,totals.get(a.prefix),year);const bProgress=prefixCollectionProgress(b,totals.get(b.prefix),year);
    return (order==='coverage'?(bProgress&&!bProgress.outdated?bProgress.coverage:-1)-(aProgress&&!aProgress.outdated?aProgress.coverage:-1):order==='remaining'?(bProgress?.remaining??-1)-(aProgress?.remaining??-1):b.works-a.works)||(order==='coverage'?b.works-a.works:0)||a.prefix.localeCompare(b.prefix);
  }),[visibleItems, search, filter, order, totals, year]);
  const detail=visibleItems.find(item=>item.prefix===selected);
  const open=(item:PrefixCollection)=>{setSelected(null);onOpenEntity({type:'prefix',value:item.prefix,label:item.prefix});};
  const edit=(item:PrefixCollection)=>{save.reset();setDraft(totals.get(item.prefix)??item.numberRange?.max??null);setEditing(item);};
  const ready=totalsQuery.isSuccess;
  const hasMore=visibleCount<rows.length;
  const loadMore=()=>setVisibleCount(current=>Math.min(current+24,rows.length));
  const sentinelRef=useInfiniteScroll({enabled:ready,hasNextPage:hasMore,isFetchingNextPage:false,onLoadMore:loadMore,rootMargin:'400px 0px'});
  return <div className="prefix-analytics">
    <section className="analytics-card prefix-comparison" aria-label="番号系列收录对比">
      <header className="prefix-heading"><div><h3>番号收录 <small>{count(visibleItems.filter(item=>item.works>0).length)} 个系列 · {count(visibleWorks)} 部馆藏</small></h3><p>每张卡片直接对比收录比例 · 同一作品的多个版本合并计数</p></div><div className="prefix-filters"><Input aria-label="搜索番号系列" prefix={<Search size={14}/>} placeholder="搜索番号，如 SONE" value={search} allowClear onChange={event=>{setSearch(event.target.value);setVisibleCount(24);}}/><Select aria-label="番号收录范围" value={filter} onChange={value=>{setFilter(value);setVisibleCount(24);}} options={[{value:'all',label:t("全部番号")},{value:'held',label:'本馆已有'},{value:'manual',label:'已设置总量'},{value:'gaps',label:'有已知缺口'}]}/><Select aria-label={t("番号排序")} value={order} onChange={value=>{setOrder(value);setVisibleCount(24);}} options={[{value:'works',label:'已收录最多'},{value:'coverage',label:'收录比例最高'},{value:'remaining',label:'距总量最多'}]}/></div></header>
      <div className="prefix-list-caption"><span>{year===null?'金色为已收录，灰色为剩余；编号估算不等于已核实的发行总量。':`${year} 年范围仅展示该年作品数，完整系列比例需查看全部发行年。`}</span>{year!==null&&<Button size="small" onClick={onShowAllYears}>查看全部发行年</Button>}</div>
      {totalsQuery.isError&&<Alert type="error" message="系列总量加载失败" action={<Button onClick={()=>void totalsQuery.refetch()}>{t("重试")}</Button>}/>}
      {!ready&&!totalsQuery.isError&&<div className="prefix-list-status" role="status">正在读取系列总量…</div>}
      {ready&&<div className="prefix-progress-grid">{rows.slice(0,visibleCount).map(item=>{const value=progress(item);const valid=value&&!value.outdated;return <article className="prefix-progress-card" key={item.prefix} aria-label={`${item.prefix} 收录进度`}>
        <button className="prefix-card-chart" aria-label={`查看 ${item.prefix} 收录详情`} onClick={()=>setSelected(item.prefix)}>
          <span className="prefix-card-title"><b>{item.prefix}</b><small>{year!==null?`${year} 年`:value?.outdated?'总量待更新':value?.basis==='manual'?'已设总量':value?'编号估算':'总量待设置'}</small></span>
          <span className="prefix-card-visual">
            <svg className={`prefix-card-pie${valid?'':' is-unknown'}`} viewBox="0 0 64 64" role="img" aria-label={valid?`${item.prefix} 收录饼图：已收录 ${count(item.works)} 部，占 ${percent(value.coverage)}，剩余 ${count(value.remaining)} 部${value.basis==='estimate'?'，按编号估算':''}`:`${item.prefix} 收录比例暂不可计算`}>
              <circle className="prefix-pie-track" cx="32" cy="32" r="25"/>
              {valid&&<circle className="prefix-pie-owned" cx="32" cy="32" r="25" pathLength="100" strokeDasharray={`${Math.max(0,Math.min(100,value.coverage*100))} 100`} transform="rotate(-90 32 32)"/>}
            </svg>
            <span className="prefix-card-percentage"><strong>{valid?percent(value.coverage):'—'}</strong><small>{year!==null?'年度作品':value?.basis==='estimate'?'参考收录率':'收录率'}</small></span>
          </span>
          <progress max={1} value={valid?Math.min(1,value.coverage):0} aria-label={`${item.prefix} ${valid?percent(value.coverage):'总量未确定'}`}/>
          <span className="prefix-card-count"><strong>{count(item.works)}<small> / {value?count(value.total):'—'} {t("部")}</small></strong><small>已收录 / {value?.basis==='estimate'?'参考总量':'总量'}</small></span>
          <span className="prefix-card-caption">{value?.outdated?'请更新系列总量':value?`${value.basis==='estimate'?'距参考总量':'尚未收录'} ${count(value.remaining)} 部`:year!==null?'切换全部发行年查看比例':'设置总量后即可计算百分比'}</span>
        </button><footer><Button size="small" type="text" disabled={year!==null} onClick={()=>edit(item)} aria-label={`设置 ${item.prefix} 总量`} icon={<Settings2 size={12}/>}>总量</Button><Button size="small" type="text" disabled={!item.works} onClick={()=>open(item)} aria-label={`查看 ${item.prefix} 馆藏`}>馆藏 <ArrowUpRight size={12}/></Button></footer>
      </article>;})}</div>}
      {ready&&!rows.length&&<Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有符合条件的番号系列"/>}
      {ready&&rows.length>0&&<div ref={sentinelRef} className="prefix-list-status"><span role="status">{t("已显示")} {count(Math.min(visibleCount,rows.length))} / {count(rows.length)} {t("个系列")}{hasMore?' · 向下滚动继续浏览':' · 已全部展示'}</span>{hasMore&&<Button type="text" size="small" onClick={loadMore}>加载更多系列</Button>}</div>}
    </section>
    <Drawer title={`${detail?.prefix??''} · 收录详情`} open={Boolean(detail)} onClose={()=>setSelected(null)} size={620} className="prefix-detail">
      {detail&&<>
        <div className="prefix-detail-title"><div><h2>{detail.prefix}</h2><p>{year===null?'全部发行年':`${year} 年发行`} · {count(detail.works)} 部作品 · {count(detail.files)} {t("个文件")}</p></div><Button disabled={!detail.works} onClick={()=>open(detail)}>查看全部馆藏</Button></div>
        <div className="prefix-detail-ratios"><div><h4>占本馆比例</h4><Ratio value={detail.libraryShare} numerator={detail.works} denominator={data.totalWorks}/></div><div><h4>已知目录收录率</h4><Ratio value={detail.knownCoverage} numerator={detail.works} denominator={detail.knownWorks}/></div></div>
        <p className="prefix-method">已知目录 = 本馆作品与已成功获取元数据作品的并集。此处的 100% 仅表示已知作品均已入馆，不代表系列已收齐。{data.unresolvedCatalogRecords>0&&`另有 ${count(data.unresolvedCatalogRecords)} 条歧义目录记录未计入。`}</p>
        <h3>已知但未入馆 · {count(detail.missingWorks)} {t("部")}</h3>
        <Table size="small" rowKey="code" dataSource={detail.missing} pagination={false} scroll={{x:480,y:420}} columns={[{title:t("番号"),dataIndex:'code',width:128},{title:'作品',dataIndex:'title',ellipsis:true,render:(value:string)=>value||'暂无标题'},{title:t("发行日期"),dataIndex:'releaseDate',width:106,render:(value:string|null)=>value??'未记录'},{title:'元数据来源',dataIndex:'provider',width:102}]} locale={{emptyText:'当前已知目录没有未入馆作品，完整发行目录仍待核实'}}/>
        <p className="prefix-provenance">目录依据：本馆索引{detail.providers.length?`、${detail.providers.join('、')}`:''}。元数据最近获取：{data.metadataUpdatedAt?new Date(data.metadataUpdatedAt).toLocaleDateString(getIntlLocale()):'未记录'}。</p>
      </>}
    </Drawer>
    <Modal title={`${editing?.prefix??''} · 设置系列总量`} open={Boolean(editing)} onCancel={()=>{if(!save.isPending)setEditing(null);}} closable={!save.isPending} mask={{closable:!save.isPending}} footer={<><Button disabled={save.isPending||!editing||!totals.has(editing.prefix)} onClick={()=>editing&&save.mutate({prefix:editing.prefix,total:null})}>恢复编号估算</Button><Button type="primary" loading={save.isPending} disabled={!editing||draft===null||!Number.isSafeInteger(draft)||draft<Math.max(1,editing.knownWorks)} onClick={()=>editing&&save.mutate({prefix:editing.prefix,total:draft})}>保存总量</Button></>}>
      <div className="prefix-total-editor"><p>填写该番号系列的作品总数。收录率 = 本馆去重作品数 ÷ 系列总量；总量保存在本馆数据库中。</p><label htmlFor="prefix-total-input">系列作品总量</label><InputNumber id="prefix-total-input" aria-label="系列作品总量" min={Math.max(1,editing?.knownWorks??1)} max={10000000} value={draft} onChange={setDraft} disabled={save.isPending}/><small>当前已知至少 {count(editing?.knownWorks??0)} 部；请按可信目录填写，不将编号估算视为发行事实。</small>{save.isError&&<Alert type="error" message={save.error.message}/>}</div>
    </Modal>
  </div>;
}
