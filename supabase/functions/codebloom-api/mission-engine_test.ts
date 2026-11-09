import {executeMission,type MissionConfig} from './mission-engine.ts';
const config:MissionConfig={grid:{cols:3,rows:2},start:{x:0,y:0},goal:{x:2,y:0}};
function assert(value:unknown){if(!value) throw new Error('Assertion failed');}
Deno.test('server derives completion from commands rather than a claimed score',()=>{
  assert(executeMission(config,'[{"type":"move"},{"type":"move"}]',10).reachedGoal);
  assert(!executeMission(config,'[{"type":"turn_right"}]',10).reachedGoal);
});
Deno.test('walls and board boundaries block movement',()=>{
  assert(executeMission({...config,obstacles:[{x:1,y:0}]},'[{"type":"move"},{"type":"move"}]',10).finalX===0);
  assert(executeMission(config,'[{"type":"turn_left"},{"type":"move"}]',10).finalY===0);
});
Deno.test('step cap bounds execution and prevents a false completion',()=>{
  const result=executeMission(config,'[{"type":"move"},{"type":"move"}]',1);
  assert(result.steps===1&&result.stoppedEarly&&!result.reachedGoal);
});
Deno.test('malformed and empty programs cannot earn rewards',()=>{
  for(const value of ['[]','{}','null','[{"type":"eval"}]']){
    let failed=false;try{executeMission(config,value,10);}catch{failed=true;}assert(failed);
  }
});
