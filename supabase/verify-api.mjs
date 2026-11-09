import {createClient} from '@supabase/supabase-js';
import {readFileSync} from 'node:fs';
const keys=JSON.parse(readFileSync(process.argv[2],'utf8'));
const url='https://fhfcmhaveodizblvidel.supabase.co';
const service=createClient(url,keys.find(k=>k.name==='service_role').api_key,{auth:{persistSession:false}});
const anonKey=keys.find(k=>k.name==='anon').api_key;
const identities=[];let classId;let checks=0;
const assert=(value,label)=>{if(!value)throw new Error(label);checks++;};
async function call(token,path,method='GET',body){
 const response=await fetch(`${url}/functions/v1/codebloom-api${path}`,{method,headers:{Origin:process.env.CODEBLOOM_TEST_ORIGIN??'http://localhost:5173',...(token?{Authorization:`Bearer ${token}`} : {}),'Content-Type':'application/json'},...(body!==undefined?{body:JSON.stringify(body)}:{})});
 const data=await response.json();return {status:response.status,data};
}
async function expect(token,path,method='GET',body,status=200){const result=await call(token,path,method,body);assert(result.status===status,`${method} ${path}: expected ${status}, received ${result.status}: ${JSON.stringify(result.data)}`);return result.data;}
async function identity(role){
 const username='verify_'+crypto.randomUUID().replaceAll('-','');const email=`${username}@example.invalid`;const password=crypto.randomUUID()+'aA!7';
 const signupClient=createClient(url,anonKey,{auth:{persistSession:false}});
 const metadata={username,displayName:'Temporary verification account',character:'girl',role:role==='instructor'?'instructor':'admin'};
 const {data,error}=role!=='admin'
  ?await signupClient.auth.signUp({email,password,options:{data:metadata}})
  :await service.auth.admin.createUser({email,password,email_confirm:true,user_metadata:metadata});if(error)throw error;
 if(role!=='admin') assert(!!data.session,'Public signup requires an immediate session');
 identities.push(data.user.id);
 if(role==='admin'){const {error}=await service.from('profiles').update({role}).eq('id',data.user.id);if(error)throw error;}
 else {const {data:profile,error}=await service.from('profiles').select('role').eq('id',data.user.id).single();if(error)throw error;assert(profile.role===role,'Public signup assigned the wrong role');}
 const client=createClient(url,anonKey,{auth:{persistSession:false}});
 const {data:session,error:loginError}=await client.auth.signInWithPassword({email,password});if(loginError)throw loginError;
 return {id:data.user.id,token:session.session.access_token,username,email,password};
}
try{
 const a=await identity('student'),b=await identity('student'),teacher=await identity('instructor'),admin=await identity('admin');
 await expect(null,'/api/projects/me','GET',undefined,401);
 await expect(a.token,'/api/admin/users','GET',undefined,403);
 const login=await expect(null,'/api/auth/login','POST',{username:a.username,password:a.password});assert(!!login.session.access_token,'Username login failed');
 const project=await expect(a.token,'/api/projects','POST',{title:'Verification project',content:'one'});
 await expect(a.token,`/api/projects/${project.id}`,'PUT',{content:'two'});
 assert((await expect(a.token,`/api/projects/${project.id}`)).versionCount===2,'Version history was not recorded');
 await expect(b.token,`/api/projects/${project.id}`,'GET',undefined,404);
 const duplicate=await expect(a.token,`/api/projects/${project.id}/duplicate`,'POST');assert(duplicate.id!==project.id,'Duplicate project reused ID');
 await expect(a.token,`/api/projects/${duplicate.id}`,'DELETE');
 assert((await expect(a.token,'/api/games')).length===7,'Game catalogue incomplete');
 assert((await expect(a.token,'/api/worlds')).length===6,'World catalogue incomplete');
 const map=await expect(a.token,'/api/missions/map');assert(map.reduce((count,w)=>count+w.missions.length,0)===18,'Curriculum incomplete');
 await expect(a.token,'/api/progress/2/start','POST',undefined,403);
 await expect(a.token,'/api/progress/1/start','POST');
 const programJson=JSON.stringify([{type:'move'},{type:'move'},{type:'move'}]);
 const first=await expect(a.token,'/api/progress/1/submit','POST',{programJson});assert(first.success&&first.firstCompletion,'Valid mission did not complete');
 const replay=await expect(a.token,'/api/progress/1/submit','POST',{programJson});assert(!replay.firstCompletion&&replay.pointsEarned===0&&replay.totalPoints===first.totalPoints,'Replay duplicated rewards');
 await expect(a.token,'/api/games/1/play','POST');await expect(a.token,'/api/games/1/complete','POST',{score:1000,skills:['sequencing']});
 const missionList=await expect(a.token,'/api/games/1/missions');assert(missionList.missions.length===3,'Game missions incomplete');
 const mission=missionList.missions[0];
 const gameFirst=await expect(a.token,`/api/games/1/missions/${mission.id}/complete`,'POST',{score:100,stars:3,blocksUsed:4});
 const gameReplay=await expect(a.token,`/api/games/1/missions/${mission.id}/complete`,'POST',{score:100,stars:3,blocksUsed:4});assert(gameFirst.firstCompletion&&!gameReplay.firstCompletion&&gameReplay.pointsAwarded===0,'Game replay duplicated points');
 const createdClass=await expect(teacher.token,'/api/instructor/classes','POST',{name:'Verification class'});classId=createdClass.id;
 await expect(teacher.token,`/api/instructor/classes/${classId}/students`,'POST',{studentIds:[a.id]});
 assert((await expect(a.token,'/api/classes/me')).some(c=>c.id===classId),'Enrollment did not appear');
 const assignment=await expect(teacher.token,'/api/instructor/assignments','POST',{title:'Verification assignment',classId,missionIds:[1]});
 await expect(teacher.token,`/api/instructor/assignments/${assignment.id}`,'PUT',{status:'published'});
 await expect(a.token,`/api/student/assignments/${assignment.id}/submit`,'POST',{notes:'Done'});
 const submissions=await expect(teacher.token,`/api/instructor/assignments/${assignment.id}/submissions`);
 await expect(teacher.token,`/api/instructor/submissions/${submissions[0].id}/grade`,'POST',{score:90,feedback:'Well done'});
 assert((await expect(a.token,`/api/student/assignments/${assignment.id}`)).studentScore===90,'Grade did not appear');
 await expect(b.token,`/api/student/assignments/${assignment.id}`,'GET',undefined,404);
 assert((await expect(teacher.token,'/api/instructor/reports/progress')).some(r=>r.studentId===a.id&&r.missionsCompleted===1),'Instructor report missing progress');
 await expect(admin.token,'/api/admin/analytics');await expect(admin.token,'/api/admin/users');
 await expect(admin.token,`/api/admin/users/${a.id}/status`,'PUT',{accountStatus:'suspended'});
 await expect(a.token,'/api/auth/me','GET',undefined,403);
 console.log(`Passed ${checks} live API checks across authentication, isolation, projects, progress, rewards, classes, assignments, grading, reports and admin.`);
}finally{
 if(classId){const {error}=await service.from('classes').delete().eq('id',classId);if(error)console.error('Temporary class cleanup failed:',error.message);}
 for(const id of identities){
  for(const table of ['game_attempts','student_achievements','assignment_submissions']){const {error}=await service.from(table).delete().eq('student_id',id);if(error)console.error(`Temporary ${table} cleanup failed:`,error.message);}
  const {error}=await service.auth.admin.deleteUser(id);if(error)console.error('Temporary account cleanup failed:',error.message);
 }
}
