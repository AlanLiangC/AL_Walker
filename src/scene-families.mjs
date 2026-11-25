// A divider is the gap between successive pedestrian rows (h) or columns (v).
// Roads run along the entire divider. Walkway edges bridge them at marked crossings.
export const sceneFamilies = [
  { id:'boulevard', name:'城市主干道', h:[1],v:[1], modes:['signal'], edge:'normal', surface:'paving', density:5, color:'#afb9c2', facility:'commercial' },
  { id:'oldtown', name:'老城窄巷', h:[0,2],v:[], modes:['yield','stop'], edge:'narrow', surface:'brick', density:8, color:'#bb9e84', facility:'commercial' },
  { id:'school', name:'校门与学区', h:[1],v:[2], modes:['guard','stop'], edge:'school', surface:'paving', density:4, color:'#c4a789', facility:'school' },
  { id:'transit', name:'公交换乘站', h:[0,2],v:[1], modes:['signal','yield'], edge:'transit', surface:'paving', density:4, color:'#99abbc', facility:'transit' },
  { id:'works', name:'施工改道区', h:[1],v:[0,3], modes:['signal','stop'], edge:'works', surface:'concrete', density:5, color:'#beb6a5', facility:'works' },
  { id:'park', name:'城市公园', h:[],v:[2], modes:['yield'], edge:'park', surface:'paving', density:1, color:'#acb69b', facility:'park' },
  { id:'waterfront', name:'滨水栈道', h:[0],v:[], modes:['signal','yield'], edge:'bike', surface:'paving', density:2, color:'#aab9b8', facility:'water' },
  { id:'market', name:'市场与步行街', h:[2],v:[0,3], modes:['stop','yield'], edge:'crowd', surface:'brick', density:4, color:'#c7ab92', facility:'market' },
  { id:'clinic', name:'医院落客区', h:[1],v:[2], modes:['yield','stop'], edge:'clinic', surface:'concrete', density:5, color:'#babeba', facility:'clinic' },
  { id:'office', name:'办公区街网', h:[0,2],v:[1,3], modes:['signal'], edge:'bike', surface:'paving', density:7, color:'#9eadba', facility:'commercial' },
  { id:'campus', name:'校园共享通道', h:[],v:[], modes:[], edge:'shared', surface:'paving', density:3, color:'#bcb197', facility:'school' },
  { id:'depot', name:'物流园出入口', h:[1],v:[0,2], modes:['stop','yield'], edge:'loading', surface:'concrete', density:5, color:'#a6a6a0', facility:'works' },
];

export const sceneVariants = [
  { name:'中心街坊', stretch:[1,1], blocked:['h2-1'], crossing:'mixed', traffic:1 },
  { name:'南门入口', stretch:[1.08,.92], blocked:['v1-1','h0-2'], crossing:'alternate', traffic:1.12 },
  { name:'东西走廊', stretch:[1.2,.84], blocked:['h1-0','h0-2','v3-1'], crossing:'mixed', traffic:.92 },
  { name:'内街小区', stretch:[.88,1.16], blocked:['v1-1','v2-1','h1-2'], crossing:'alternate', traffic:.86 },
  { name:'外缘通道', stretch:[1.12,1.08], blocked:['v2-0','h2-0','h1-2'], crossing:'mixed', traffic:1.18 },
  { name:'支路换乘', stretch:[.94,1.12], blocked:['h1-1','v3-0'], crossing:'alternate', traffic:1.22 },
  { name:'北广场', stretch:[1.14,.91], blocked:['v0-1','h2-1','v3-2'], crossing:'mixed', traffic:1.02 },
  { name:'斜向接驳', stretch:[.92,1.21], blocked:['h1-1','h2-2','v2-0'], crossing:'alternate', traffic:1.07 },
  { name:'狭窄绕行', stretch:[1.04,.97], blocked:['v1-1','h2-1','v3-1','h0-2'], crossing:'mixed', traffic:1.14 },
];

export const scenarios = [
  { id:'routine', name:'常规通行', density:1, slack:1.13 },
  { id:'commute', name:'通勤高峰', density:1.52, slack:1.23 },
  { id:'quiet', name:'低流量接驳', density:.64, slack:1.1 },
  { id:'courier', name:'配送交会', density:1.18, slack:1.15 },
  { id:'rush', name:'密集行人', density:1.24, crowd:true, slack:1.22 },
  { id:'staggered', name:'变化的信号相位', density:1.09, slack:1.24 },
  { id:'slow', name:'拥挤慢行', density:.88, crowd:true, slack:1.29 },
  { id:'wet', name:'湿地通行', density:.94, domain:'wet', slack:1.24 },
  { id:'night', name:'夜间低能见度', density:.73, domain:'night', slack:1.24 },
  { id:'deadline', name:'限时派送', density:.91, slack:1.02 },
  { id:'downpour', name:'暴雨强侧风', domain:'storm', density:1.36, slack:1.60 },
  { id:'whiteout', name:'暴雪与结冰', domain:'blizzard', density:1.03, slack:1.78 },
  { id:'zero-visibility', name:'浓雾穿行', domain:'fog', density:1.28, slack:1.48 },
  { id:'crowd-surge', name:'双向人潮瓶颈', domain:'outdoor', density:3.9, crowd:true, streams:3, slack:1.74 },
  { id:'gridlock', name:'多车道路口排队', domain:'outdoor', density:2.7, queueSize:5, slack:1.64 },
  { id:'storm-rush', name:'雨夜晚高峰', domain:'storm-night', density:3.4, queueSize:4, crowd:true, streams:2, slack:1.88 },
];

const pad=(n,width=2)=>String(n).padStart(width,'0');
export const benchmarkVersion='citynav-urban-v1';
export const challengeVersion='citynav-extreme-v1';
export const sceneCatalog=sceneFamilies.flatMap((family,f) => sceneVariants.map((variant,v) => ({
  id:family.id+'-'+pad(v+1),name:family.name+' · '+variant.name,family:family.id,familyName:family.name,
  variant:v+1,split:v<6?'train':v<7?'validation':'test',seed:15023+f*24179+v*6271,
})));

export const episodeCatalog=sceneCatalog.flatMap((scene,index) => Array.from({length:20},(_,i) => {
  const scenario=scenarios[i%10];
  return { id:scene.id+'-e'+pad(i+1),sceneId:scene.id,sceneName:scene.name,split:scene.split,
    name:scenario.name,scenario:scenario.id,routeIndex:i,
    seed:(Math.imul(32519+index,22695477)+Math.imul(i+17,1103515245))>>>0,
    domain:scenario.domain ?? (i%3===0?'ideal':'outdoor') };
}));

const scenes=new Map(sceneCatalog.map(scene=>[scene.id,scene]));
const challengeScenes=[
  ['downpour',['boulevard-02','oldtown-06','transit-03','works-08','waterfront-07','market-05','clinic-09','office-07']],
  ['whiteout',['school-02','works-04','park-08','waterfront-05','clinic-07','office-02','campus-09','depot-08']],
  ['zero-visibility',['boulevard-08','oldtown-09','school-07','transit-05','park-01','market-07','clinic-03','depot-06']],
  ['crowd-surge',['school-03','transit-08','park-09','waterfront-04','market-02','market-09','campus-03','campus-07']],
  ['gridlock',['boulevard-04','school-09','transit-07','works-05','market-08','clinic-04','office-09','depot-07']],
  ['storm-rush',['boulevard-09','oldtown-04','school-08','transit-09','works-07','market-03','office-08','depot-03']],
];
export const challengeCatalog=challengeScenes.flatMap(([family,ids],i)=>ids.map((sceneId,j)=>{
  const scene=scenes.get(sceneId);
  const scenario=scenarios.find(item=>item.id===family);
  return { id:sceneId+'-x'+pad(i+1),sceneId,sceneName:scene.name,split:scene.split,
    name:scenario.name,scenario:family,difficulty:'extreme',seed:(7627339+(i*8+j)*1357531)>>>0,domain:scenario.domain };
}));
const episodes=new Map([...episodeCatalog,...challengeCatalog].map(episode=>[episode.id,episode]));
export const findScene=id=>scenes.get(id);
export const findEpisode=id=>episodes.get(id);
