import { writeFileSync } from 'node:fs';
import { benchmarkVersion, challengeCatalog, challengeVersion, episodeCatalog, sceneCatalog } from '../src/scene-families.mjs';
import { describeUrbanEpisode } from '../src/urban-episode.mjs';

function serializeEpisode({id}) {
  const { sceneName,benchmarkVersion,challengeVersion,crossings,speedZones,restricted,...episode }=describeUrbanEpisode(id);
  return { ...episode,crossings:crossings.map(({id,mode})=>({ id,mode })) };
}
const manifest={ version:benchmarkVersion,scenes:sceneCatalog,episodes:episodeCatalog.map(serializeEpisode),
  challengeVersion,challenges:challengeCatalog.map(serializeEpisode) };
const encoded=JSON.stringify(manifest)+'\n';
const name=process.argv[2];
if (name) writeFileSync(name,encoded);
else process.stdout.write(encoded);
