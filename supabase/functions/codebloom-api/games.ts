import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import catalogue from './catalogue.json' with { type: 'json' };
import gameMissions from './game-missions.json' with {type:'json'};

export async function gamesRoute(client: SupabaseClient, path: string, request: Request) {
  if (!path.startsWith('/api/games')) return null;
  if(path==='/api/games/progress'||/^\/api\/games\/\d+\/missions/.test(path)){
    const {data:attempts,error}=await client.from('game_attempts').select('*').order('created_at',{ascending:true});
    if(error) throw error;
    const best=(id:number)=>{const rows=attempts.filter(a=>a.mission_id===id);return {bestStars:Math.max(0,...rows.map(a=>a.stars)),bestScore:Math.max(0,...rows.map(a=>a.score)),attempts:rows.length,completed:rows.some(a=>a.stars>0),bestTimeSeconds:rows.filter(a=>a.stars>0&&a.time_taken_seconds!=null).reduce((best:number|null,a)=>best===null?a.time_taken_seconds:Math.min(best,a.time_taken_seconds),null)};};
    const gameProgress=(gameId:number)=>{const list=gameMissions.filter(m=>m.gameId===gameId);const ids=new Set(list.map(m=>m.id));const rows=attempts.filter(a=>ids.has(a.mission_id));const next=list.find(m=>!best(m.id).completed)??list.at(-1);
      return {gameId,gameKey:catalogue[gameId-1]?.key,currentMissionId:next?.id,currentMissionKey:next?.key,totalScore:list.reduce((sum,m)=>sum+best(m.id).bestScore,0),totalStars:list.reduce((sum,m)=>sum+best(m.id).bestStars,0),missionsCompleted:list.filter(m=>best(m.id).completed).length,attempts:rows.length,firstPlayedAt:rows[0]?.created_at??null,lastPlayedAt:rows.at(-1)?.created_at??null};};
    if(path==='/api/games/progress'&&request.method==='GET') return {body:catalogue.map((_,index)=>gameProgress(index+1)).filter(p=>p.attempts>0)};
    const match=path.match(/^\/api\/games\/(\d+)\/missions(?:\/(\d+)\/(start|complete))?$/);
    if(!match) return null;
    const gameId=Number(match[1]);const list=gameMissions.filter(m=>m.gameId===gameId);
    if(!list.length) return {body:{error:'Game not found'},status:404};
    if(!match[2]&&request.method==='GET') {const progress=gameProgress(gameId);return {body:{missions:list.map(m=>({...m,...best(m.id)})),progress,totalMissions:list.length,completedMissions:progress.missionsCompleted,totalStars:progress.totalStars,starsAvailable:list.reduce((sum,m)=>sum+m.starsAvailable,0)}};}
    const mission=list.find(m=>m.id===Number(match[2]));if(!mission) return {body:{error:'Mission not found'},status:404};
    if(match[3]==='start'&&request.method==='POST') return {body:{attemptNumber:best(mission.id).attempts+1,...best(mission.id)}};
    if(match[3]==='complete'&&request.method==='POST'){
      const raw=await request.text();if(raw.length>110000) return {body:{error:'Attempt too large'},status:413};
      let body;try{body=JSON.parse(raw);}catch{return {body:{error:'Invalid JSON'},status:400};}
      if(!Number.isInteger(body.score)||body.score<0||body.score>10000||!Number.isInteger(body.stars)||body.stars<0||body.stars>mission.starsAvailable||!Number.isInteger(body.blocksUsed)||body.blocksUsed<0||body.blocksUsed>2000||body.programJson!=null&&typeof body.programJson!=='string'||body.timeTakenSeconds!=null&&(!Number.isInteger(body.timeTakenSeconds)||body.timeTakenSeconds<0||body.timeTakenSeconds>86400)) return {body:{error:'Invalid attempt'},status:400};
      const {data:earned,error:earnedError}=await client.from('student_achievements').select('achievement_id');if(earnedError) throw earnedError;
      const {data,error}=await client.rpc('record_game_mission',{p_mission:mission.id,p_score:body.score,p_stars:body.stars,p_blocks:body.blocksUsed,p_time:body.timeTakenSeconds??null,p_program:body.programJson??null});if(error) throw error;
      const {data:after,error:afterError}=await client.from('game_attempts').select('*').eq('mission_id',mission.id);if(afterError) throw afterError;
      attempts.splice(0,attempts.length,...attempts.filter(a=>a.mission_id!==mission.id),...after);
      const {data:newEarned,error:newError}=await client.from('student_achievements').select('achievement_id');if(newError) throw newError;
      const newIds=newEarned.filter(a=>!earned.some(e=>e.achievement_id===a.achievement_id)).map(a=>a.achievement_id);
      const {data:catalog,error:catalogError}=await client.from('achievement_catalog').select('id,data');if(catalogError) throw catalogError;
      const newAchievements=catalog.filter(a=>newIds.includes(a.id)).map(a=>a.data.title);
      return {body:{...gameProgress(gameId),...data,newAchievement:newAchievements.length>0,newAchievementTitle:newAchievements.at(-1)??null,newAchievements}};
    }
    return {body:{error:'Method not allowed'},status:405};
  }
  if(request.method === 'POST') {
    const match=path.match(/^\/api\/games\/(\d+)\/(play|complete)$/);
    if(!match) return null;
    const game=catalogue[Number(match[1])-1];
    if(!game) return {body:{error:'Game not found'},status:404};
    let score=0;
    if(match[2]==='complete') {
      const raw=await request.text();
      if(raw.length>5000) return {body:{error:'Request too large'},status:413};
      let body;
      try {body=JSON.parse(raw);} catch {return {body:{error:'Invalid JSON'},status:400};}
      if(!Number.isInteger(body.score)||body.score<0||body.score>10000) return {body:{error:'Score must be between 0 and 10000'},status:400};
      score=body.score;
    }
    const {data:before,error:readError}=await client.from('game_plays').select('completed').eq('game_key',game.key).maybeSingle();
    if(readError) throw readError;
    const {data,error}=await client.rpc('record_game_play',{p_game_key:game.key,p_complete:match[2]==='complete',p_score:score});
    if(error) throw error;
    return {body:{playCount:data.play_count,completed:data.completed,bestScore:data.best_score,firstCompletion:!before?.completed&&data.completed}};
  }
  if(request.method !== 'GET') return null;
  const {data:plays,error} = await client.from('game_plays').select('*');
  if(error) throw error;
  const games = catalogue.map((game,index)=>{
    const record=plays.find(play=>play.game_key===game.key);
    return {id:index+1,key:game.key,title:game.title,tagline:game.tagline,description:game.description,
      genre:game.category,difficulty:game.difficulty,skills:game.skills,estimatedMinutes:game.estimatedMinutes,
      backgroundKey:game.key,objective:game.objective,isFeatured:index===0,order:index+1,sceneJson:'{}',
      hints:game.hints,playCount:record?.play_count??0,completed:record?.completed??false,
      bestScore:record?.best_score??0,lastPlayedAt:record?.last_played_at??null};
  });
  if(path==='/api/games') return {body:games};
  if(path==='/api/games/recent') return {body:games.filter(game=>game.lastPlayedAt)
    .sort((a,b)=>String(b.lastPlayedAt).localeCompare(String(a.lastPlayedAt))).slice(0,6).map(game=>({...game,gameId:game.id}))};
  const match=path.match(/^\/api\/games\/(\d+)$/);
  if(match){const game=games.find(game=>game.id===Number(match[1]));return game?{body:game}:{body:{error:'Game not found'},status:404};}
  return null;
}
