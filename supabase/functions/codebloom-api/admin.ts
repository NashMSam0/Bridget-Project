import type {SupabaseClient} from 'npm:@supabase/supabase-js@2';
import seed from './curriculum.json' with {type:'json'};
const camel=(row:Record<string,unknown>)=>Object.fromEntries(Object.entries(row).map(([key,value])=>[key.replace(/_([a-z])/g,(_,c)=>c.toUpperCase()),value]));
export async function adminRoute(client:SupabaseClient,service:()=>SupabaseClient,role:string,path:string,request:Request){
 if(!path.startsWith('/api/admin/')) return null;
 if(role!=='admin') return {body:{error:'Administrator access required'},status:403};
 const admin=service();
 if(request.method==='GET'){
  if(path==='/api/admin/worlds') return {body:seed.worlds};
  if(path==='/api/admin/audit-logs'){const {data,error}=await client.from('audit_logs').select('*').order('created_at',{ascending:false}).limit(200);if(error) throw error;return {body:data.map(camel)};}
  if(path==='/api/admin/settings'){const {data,error}=await client.from('platform_settings').select('*');if(error) throw error;return {body:data.map(camel)};}
  if(path==='/api/admin/users'){
   const {data,error}=await client.rpc('admin_user_directory');if(error) throw error;
   return {body:data.map((row:Record<string,unknown>)=>camel(row))};
  }
  if(path==='/api/admin/missions'){
   const {data,error}=await client.from('mission_overrides').select('*');if(error) throw error;
   const merged=new Map<number,Record<string,unknown>>(seed.missions.map(m=>[m.id,m]));
   for(const row of data) merged.set(row.id,{...row.data,id:row.id});
   return {body:[...merged.values()].map(m=>({...m,worldKey:seed.worlds.find(w=>w.id===m.worldId)?.key}))};
  }
  if(path==='/api/admin/analytics'){
   const {data:users,error}=await admin.from('profiles').select('role');if(error) throw error;
   const {data:progress,error:progressError}=await admin.from('mission_progress').select('mission_id,status');if(progressError) throw progressError;
   const {count,error:attemptError}=await admin.from('mission_attempts').select('*',{count:'exact',head:true});if(attemptError) throw attemptError;
   const {data:points,error:pointError}=await admin.from('point_transactions').select('amount');if(pointError) throw pointError;
   return {body:{totalUsers:users.length,totalStudents:users.filter(u=>u.role==='student').length,totalInstructors:users.filter(u=>u.role==='instructor').length,totalAdmins:users.filter(u=>u.role==='admin').length,
    totalMissions:seed.missions.length,totalMissionCompletions:progress.filter(p=>p.status==='completed').length,totalAttempts:count??0,totalPointsAwarded:points.reduce((sum,p)=>sum+p.amount,0),
    completionsByWorld:Object.fromEntries(seed.worlds.map(w=>[w.name,progress.filter(p=>p.status==='completed'&&seed.missions.some(m=>m.worldId===w.id&&m.id===p.mission_id)).length]))}};
  }
 }
 const raw=await request.text();if(raw.length>120000) return {body:{error:'Request too large'},status:413};
 let body;try{body=raw?JSON.parse(raw):{};}catch{return {body:{error:'Invalid JSON'},status:400};}
 const user=path.match(/^\/api\/admin\/users\/([a-f0-9-]{36})\/(role|status)$/);
 if(user&&request.method==='PUT'){
  if(user[2]==='role'&&!['student','instructor','admin'].includes(body.role)||user[2]==='status'&&!['active','suspended'].includes(body.accountStatus??body.status)) return {body:{error:'Invalid account change'},status:400};
  const {error}=await client.rpc('admin_update_account',{p_user:user[1],p_role:user[2]==='role'?body.role:null,p_status:user[2]==='status'?(body.accountStatus??body.status):null});if(error) throw error;return {body:{updated:true}};
 }
 if(path==='/api/admin/settings'&&request.method==='PUT'){
  if(typeof body.key!=='string'||body.key.length>200||typeof body.value!=='string'||body.value.length>10000) return {body:{error:'Invalid setting'},status:400};
  const {error}=await client.from('platform_settings').upsert({key:body.key,value:body.value,updated_at:new Date().toISOString()});if(error) throw error;return {body:{updated:true}};
 }
 const mission=path.match(/^\/api\/admin\/missions(?:\/(\d+))?(?:\/(publish|archive))?$/);
 if(mission&&['POST','PUT'].includes(request.method)){
  const id=mission[1]?Number(mission[1]):null;
  const {data:existing,error:readError}=id?await client.from('mission_overrides').select('*').eq('id',id).maybeSingle():{data:null,error:null};if(readError) throw readError;
  const previous=existing?.data??seed.missions.find(m=>m.id===id);
  if(id&&!previous) return {body:{error:'Mission not found'},status:404};
  let values={...previous};
  if(mission[2]==='archive') values={...values,isArchived:true,isPublished:false};
  else if(mission[2]==='publish') values={...values,isPublished:body.isPublished??body.publish??true};
  else{
   for(const key of ['worldId','key','title','description','learningConcept','difficulty','configJson','order','maxSteps']) if(body[key]!==undefined) values[key]=body[key];
   if(typeof values.title!=='string'||!values.title.trim()||values.title.length>200||!seed.worlds.some(w=>w.id===values.worldId)||typeof values.key!=='string'||values.key.length>100) return {body:{error:'Invalid mission details'},status:400};
   if(!Number.isInteger(values.maxSteps)||values.maxSteps<1||values.maxSteps>10000) return {body:{error:'Invalid mission step limit'},status:400};
   try{JSON.parse(values.configJson);}catch{return {body:{error:'Invalid mission configuration'},status:400};}
  }
  values={...values,version:(previous?.version??0)+1,isPublished:values.isPublished??false,isArchived:values.isArchived??false,hints:values.hints??[],prerequisiteIds:values.prerequisiteIds??[],prerequisiteKeys:values.prerequisiteKeys??[]};
  const {data,error}=id?await client.from('mission_overrides').upsert({id,data:values}).select('id').single():await client.from('mission_overrides').insert({data:values}).select('id').single();if(error) throw error;return {body:data};
 }
 return null;
}
