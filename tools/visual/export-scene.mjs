import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CityEngine } from '../../src/engine.mjs';
import { actorMesh, Mesh, pedestrianLeg } from '../../src/geometry.mjs';
import { urbanMesh } from '../../src/urban-geometry.mjs';

const [episodeId,directory]=process.argv.slice(2);
if (!episodeId||!directory) throw Error('Usage: node tools/visual/export-scene.mjs EPISODE DIRECTORY');
const engine=new CityEngine({episodeId});
mkdirSync(directory,{recursive:true});
function saveMesh(file,mesh) {
  writeFileSync(join(directory,file),Buffer.from(Float32Array.from(mesh.data).buffer));
  return file;
}
const actors={};
for (const actor of engine.actors) {
  const key=actor.kind+':'+actor.color;
  if (actors[key]) continue;
  actors[key]=saveMesh('actor-'+Object.keys(actors).length+'.f32',actorMesh(actor,{detail:true}));
}
const {layout}=engine.world;
const posts=layout.posts.filter(post=>!['stop','yield'].includes(layout.crossings.find(c=>c.id===post.crossing).mode));
const signMesh=new Mesh();
const bundle={
  scene:engine.world.episode.sceneId,
  world:saveMesh('world.f32',urbanMesh(layout,{groundedMarkings:true,signMesh})),
  signs:saveMesh('signs.f32',signMesh),
  actors,
  legs:[-1,-.5,0,.5,1].map((swing,index)=>saveMesh('legs-'+index+'.f32',pedestrianLeg(swing))),
  posts,
};
writeFileSync(join(directory,'scene.json'),JSON.stringify(bundle,null,2)+'\n');
console.log(bundle.scene,Object.keys(actors).length,'actor meshes',posts.length,'signal poles');
