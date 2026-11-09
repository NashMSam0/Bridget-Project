import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import catalogue from './catalogue.json' with { type: 'json' };

export async function gamesRoute(client: SupabaseClient, path: string, request: Request) {
  if (!path.startsWith('/api/games')) return null;
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
      if(!Number.isInteger(body.score)||body.score<0||body.score>100) return {body:{error:'Score must be between 0 and 100'},status:400};
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
