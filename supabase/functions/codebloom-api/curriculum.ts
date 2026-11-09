import type {SupabaseClient} from 'npm:@supabase/supabase-js@2';
import curriculum from './curriculum.json' with {type:'json'};
import {executeMission} from './mission-engine.ts';
function camel(row:Record<string,unknown>){return Object.fromEntries(Object.entries(row).map(([key,value])=>[key.replace(/_([a-z])/g,(_,letter)=>letter.toUpperCase()),value]));}

export async function curriculumRoute(client:SupabaseClient,admin:()=>SupabaseClient,userId:string,profile:Record<string,unknown>,path:string,request:Request){
  if(!/^\/api\/(worlds|missions|progress|points|students\/me\/dashboard)/.test(path)) return null;
  const {data:rows,error}=await client.from('mission_progress').select('*');
  if(error) throw error;
  const progress=rows.map(camel);
  const completed=new Set(progress.filter(row=>row.status==='completed').map(row=>row.missionId));
  const {data:overrides,error:overrideError}=await admin().from('mission_overrides').select('*');
  if(overrideError) throw overrideError;
  const catalog=new Map<number,Record<string,unknown>>(curriculum.missions.map(m=>[m.id,m]));
  for(const override of overrides) catalog.set(override.id,{...override.data,id:override.id});
  const merged=[...catalog.values()].filter(m=>m.isPublished&&!m.isArchived) as typeof curriculum.missions;
  const missions=merged.map(mission=>({...mission,status:progress.find(row=>row.missionId===mission.id)?.status
    ??(mission.prerequisiteIds.every(id=>completed.has(id))?'available':'locked'),bestScore:progress.find(row=>row.missionId===mission.id)?.bestScore??0}));
  const points=await client.from('point_transactions').select('*');
  if(points.error) throw points.error;
  const totalPoints=points.data.reduce((total,row)=>total+row.amount,0);
  const {data:earned,error:earnedError}=await client.from('student_achievements').select('*');if(earnedError) throw earnedError;
  const {data:achievements,error:achievementError}=await client.from('achievement_catalog').select('*');if(achievementError) throw achievementError;
  if(request.method==='GET'){
    if(path==='/api/worlds') return {body:curriculum.worlds};
    if(path==='/api/missions/map') {
      if(profile.role==='student'){const {error}=await client.rpc('visit_mission_map');if(error) throw error;}
      return {body:curriculum.worlds.map(world=>({...world,missions:missions.filter(m=>m.worldId===world.id)}))};
    }
    if(path==='/api/progress/me') return {body:progress.map(row=>({...row,missionTitle:missions.find(m=>m.id===row.missionId)?.title,worldId:missions.find(m=>m.id===row.missionId)?.worldId}))};
    if(path==='/api/points/me') return {body:points.data.map(camel)};
    if(path==='/api/students/me/dashboard') return {body:{displayName:profile.display_name,character:profile.character,totalPoints,
      missionsCompleted:completed.size,missionsInProgress:missions.filter(m=>m.status==='in_progress').length,
      missionsAvailable:missions.filter(m=>m.status==='available').length,missionsLocked:missions.filter(m=>m.status==='locked').length,
      totalMissions:missions.length,achievementsEarned:earned.length,totalAchievements:achievements.length,recentAchievements:earned.sort((a,b)=>b.earned_at.localeCompare(a.earned_at)).slice(0,5).map(e=>({id:e.achievement_id,achievementId:e.achievement_id,...achievements.find(a=>a.id===e.achievement_id)?.data,earnedAt:e.earned_at})),
      availableMissions:missions.filter(m=>m.status==='available'),inProgressMissions:missions.filter(m=>m.status==='in_progress'),lockedMissions:missions.filter(m=>m.status==='locked')}};
    const worldMatch=path.match(/^\/api\/worlds\/(\d+)\/(missions|levels)$/);
    if(worldMatch){const list=missions.filter(m=>m.worldId===Number(worldMatch[1]));return {body:worldMatch[2]==='missions'?list:
      [...new Map(list.map(m=>[m.levelKey,{id:m.levelOrder,key:m.levelKey,name:m.levelName,worldId:m.worldId,order:m.levelOrder}])).values()]};}
    const missionMatch=path.match(/^\/api\/missions\/(\d+)(\/hints)?$/);
    if(missionMatch){const mission=missions.find(m=>m.id===Number(missionMatch[1]));
      if(!mission) return {body:{error:'Mission not found'},status:404};
      if(mission.status==='locked') return {body:{error:'Complete the prerequisite mission first'},status:403};
      return {body:missionMatch[2]?mission.hints:{...mission,...progress.find(row=>row.missionId===mission.id),hintsUsed:progress.find(row=>row.missionId===mission.id)?.hintsUsed??0,testCases:[]}};
    }
  }
  const match=path.match(/^\/api\/progress\/(\d+)\/(start|checkpoint|submit|attempts)$/);
  if(!match) return null;
  if(profile.role!=='student') return {body:{error:'Student access required'},status:403};
  const mission=missions.find(m=>m.id===Number(match[1]));
  if(!mission) return {body:{error:'Mission not found'},status:404};
  if(mission.status==='locked') return {body:{error:'Complete the prerequisite mission first'},status:403};
  if(match[2]==='attempts'&&request.method==='GET'){
    const {data,error}=await client.from('mission_attempts').select('*').eq('mission_id',mission.id).order('created_at',{ascending:false});
    if(error) throw error;return {body:data.map(camel)};
  }
  if(match[2]==='start'&&request.method==='POST'){
    const {data,error}=await client.rpc('start_mission',{p_mission_id:mission.id});
    if(error) throw error;return {body:camel(data)};
  }
  const raw=await request.text();if(raw.length>120000) return {body:{error:'Request too large'},status:413};
  let body;try{body=JSON.parse(raw);}catch{return {body:{error:'Invalid JSON'},status:400};}
  if(match[2]==='checkpoint'&&request.method==='PUT'){
    if((body.gameStateJson!=null&&typeof body.gameStateJson!=='string')||(body.checkpoint!=null&&typeof body.checkpoint!=='string')
      ||(body.hintsUsed!=null&&(!Number.isInteger(body.hintsUsed)||body.hintsUsed<0||body.hintsUsed>mission.hints.length))) return {body:{error:'Invalid checkpoint'},status:400};
    const {data,error}=await client.rpc('save_mission_checkpoint',{p_mission_id:mission.id,p_state:body.gameStateJson??null,p_checkpoint:body.checkpoint??null,p_hints:body.hintsUsed??null});
    if(error) throw error;return {body:camel(data)};
  }
  if(match[2]==='submit'&&request.method==='POST'){
    const current=progress.find(row=>row.missionId===mission.id);
    if(!current) return {body:{error:'Start the mission first'},status:400};
    if(typeof body.programJson!=='string') return {body:{error:'Program is required'},status:400};
    const config=JSON.parse(mission.configJson);
    let execution;try{execution=executeMission(config,body.programJson,mission.maxSteps);}catch(e){return {body:{error:(e as Error).message},status:400};}
    const {data:failures,error:attemptError}=await client.from('mission_attempts').select('id').eq('mission_id',mission.id).eq('result','failed').limit(1);
    if(attemptError) throw attemptError;
    const scoring=config.scoring;
    const score=execution.reachedGoal?scoring.main+Math.round(scoring.efficiency*Math.min(1,config.optimalBlocks/execution.commandCount))+
      (failures.length===0&&current.hintsUsed===0?scoring.bonus:0):0;
    const {data,error}=await admin().rpc('submit_validated_mission',{p_student:userId,p_mission:mission.id,p_score:score,p_success:execution.reachedGoal,p_program:body.programJson});
    if(error) throw error;
    const next=missions.find(m=>m.id===mission.id+1);
    const {data:after,error:afterError}=await client.from('student_achievements').select('*');if(afterError) throw afterError;
    const newTitles=after.filter(a=>!earned.some(e=>e.achievement_id===a.achievement_id)).map(a=>achievements.find(c=>c.id===a.achievement_id)?.data.title).filter(Boolean);
    return {body:{...data,progress:camel(data.progress),success:execution.reachedGoal,score,maxScore:scoring.main+scoring.efficiency+scoring.bonus,
      result:execution.reachedGoal?'success':'failed',message:execution.reachedGoal?'Bloom reached the goal! Mission complete.':'Bloom has not reached the goal yet. Try changing your instructions.',
      attempts:data.progress.attempts,newAchievement:newTitles.length>0,newAchievementTitle:newTitles.at(-1),nextMissionId:next?.id,nextMissionKey:next?.key}};
  }
  return {body:{error:'Method not allowed'},status:405};
}
