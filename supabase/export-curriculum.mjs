import { readFileSync, writeFileSync } from 'node:fs';
const source=readFileSync(new URL('../../uncommon-code-bloom-api/src/Uncommon.CodeBloom.Api/Data/SeedData.cs',import.meta.url),'utf8');
const section=source.slice(source.indexOf('var specs = new WorldSpec[]'),source.indexOf('foreach (var worldSpec in specs)'));
const worldPattern=/new\("(world-[^"]+)", "([^"]+)", "([^"]+)", "([^"]+)", (\d+), new\[\]/g;
const matches=[...section.matchAll(worldPattern)];
const worlds=[];const missions=[];
for(let i=0;i<matches.length;i++){
  const world=matches[i];
  worlds.push({id:i+1,key:world[1],name:world[2],tagline:world[3],description:world[4],order:Number(world[5]),isPublished:true});
  const chunk=section.slice(world.index,matches[i+1]?.index??section.length);
  const pattern=/new MissionSpec\("([^"]+)", "([^"]+)", (\d+), "([^"]+)", "([^"]+)",\s*"([^"]+)",\s*"([^"]+)", "([^"]+)", (\d+), (\d+),\s*"""([\s\S]*?)""",\s*new\[\] \{ ([\s\S]*?) \}\)/g;
  for(const match of chunk.matchAll(pattern)){
    const id=missions.length+1;
    missions.push({id,worldId:i+1,key:match[4],title:match[5],description:match[6],learningConcept:match[7],difficulty:match[8],order:Number(match[9]),maxSteps:Number(match[10]),configJson:JSON.stringify(JSON.parse(match[11])),version:1,isPublished:true,isArchived:false,
      prerequisiteIds:id>1?[id-1]:[],prerequisiteKeys:id>1?[missions[id-2].key]:[],
      hints:[...match[12].matchAll(/"([^"]+)"/g)].map((hint,index)=>({id:id*10+index,hintText:hint[1],order:index+1})),
      levelKey:match[1],levelName:match[2],levelOrder:Number(match[3])});
  }
}
if(worlds.length!==6||missions.length!==18) throw new Error(`Incomplete curriculum: ${worlds.length} worlds, ${missions.length} missions`);
writeFileSync(new URL('./functions/codebloom-api/curriculum.json',import.meta.url),JSON.stringify({worlds,missions},null,2));
console.log(`Exported ${worlds.length} worlds and ${missions.length} missions`);
const sql=missions.map(m=>`insert into public.mission_overrides(id,data) values(${m.id},'${JSON.stringify(m).replaceAll("'","''")}'::jsonb) on conflict(id) do nothing;`).join('\n');
writeFileSync(new URL('./migrations/202611090007_curriculum_seed.sql',import.meta.url),sql+'\n');
