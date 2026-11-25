import assert from 'node:assert/strict';
import { runEpisode } from './reference-controller.mjs';
import { challengeCatalog, episodeCatalog, sceneCatalog } from '../src/scene-families.mjs';
import { getUrbanScene } from '../src/urban-scene.mjs';

assert.ok(sceneCatalog.length>=100);
assert.ok(episodeCatalog.length>=2000);
assert.equal(new Set([...episodeCatalog,...challengeCatalog].map(e=>e.id)).size,episodeCatalog.length+challengeCatalog.length);
const signatures=new Set();
for (const scene of sceneCatalog) {
  const layout=getUrbanScene(scene.id);
  const pairs=layout.routes.map(({start,goal})=>start+':'+goal);
  assert.equal(new Set(pairs).size,20,scene.id);
  signatures.add(JSON.stringify([layout.nodes,layout.roads,layout.edges,layout.colliders]));
}
assert.equal(signatures.size,sceneCatalog.length);

const argumentsList=process.argv.slice(2);
const [prefix='',robotId='go2']=argumentsList.filter(arg=>arg!=='--extreme');
const episodes=(argumentsList.includes('--extreme')?challengeCatalog:episodeCatalog).filter(episode=>episode.id.startsWith(prefix));
assert.ok(episodes.length,'No matching episode IDs');
const failures=[];
for (const episode of episodes) {
  const final=runEpisode(episode.id,robotId);
  if (final.status!=='success') failures.push({
    episodeId:episode.id,reason:final.reason,events:final.events,player:final.player,
  });
}
console.log(JSON.stringify({ robotId,scenes:sceneCatalog.length,episodes:episodes.length,
  passed:episodes.length-failures.length,failed:failures.length,examples:failures.slice(0,5) },null,2));
if (failures.length) process.exitCode=1;
