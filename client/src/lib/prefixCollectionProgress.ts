import type {PrefixCollection} from '../../../server/src/libraryPrefixAnalytics';

/** A numbering estimate is a reference target, never a verified release catalog. */
export function prefixCollectionProgress(item:PrefixCollection,total:number|undefined,year:number|null) {
  if(year!==null) return null;
  const denominator=total??item.numberRange?.max;
  if(!denominator) return null;
  return {
    total:denominator, owned:item.works, remaining:Math.max(0,denominator-item.works),
    coverage:item.works/denominator, basis:total!==undefined?'manual' as const:'estimate' as const,
    outdated:denominator<item.knownWorks,
  };
}
