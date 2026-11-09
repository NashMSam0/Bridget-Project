import type {SupabaseClient} from 'npm:@supabase/supabase-js@2';
const camel=(row:Record<string,unknown>)=>Object.fromEntries(Object.entries(row).map(([key,value])=>[key.replace(/_([a-z])/g,(_,c)=>c.toUpperCase()),value]));
async function checked<T>(query:PromiseLike<{data:T;error:unknown}>){const {data,error}=await query;if(error) throw error;return data as NonNullable<T>;}

export async function classesRoute(client:SupabaseClient,admin:()=>SupabaseClient,userId:string,role:string,path:string,request:Request){
  if(!/^\/api\/(instructor|classes|student\/assignments)/.test(path)) return null;
  const staff=['instructor','admin'].includes(role);
  const instructor=path.startsWith('/api/instructor');
  if(instructor&&!staff) return {body:{error:'Instructor access required'},status:403};
  if(!instructor&&role!=='student') return {body:{error:'Student access required'},status:403};
  const classes=await checked(client.from('classes').select('*'));
  const assignments=await checked(client.from('assignments').select('*'));
  const members=await checked(client.from('class_memberships').select('*'));
  const submissions=await checked(client.from('assignment_submissions').select('*'));
  const classDto=(row:Record<string,unknown>)=>({...camel(row),studentCount:members.filter(member=>member.class_id===row.id).length,
    assignmentCount:assignments.filter(assignment=>assignment.class_id===row.id).length});
  const assignmentDto=(row:Record<string,unknown>)=>{
    const submission=submissions.find(sub=>sub.assignment_id===row.id&&sub.student_id===userId);
    return {...camel(row),className:classes.find(c=>c.id===row.class_id)?.name,
      submissionCount:submissions.filter(s=>s.assignment_id===row.id).length,
      submissionStatus:submission?.status??'pending',studentScore:submission?.score,studentFeedback:submission?.feedback,
      studentNotes:submission?.notes,studentSubmittedAt:submission?.submitted_at,
      isOverdue:!!row.deadline&&new Date(String(row.deadline)).getTime()<Date.now()&&!submission};};
  if(request.method==='GET'){
    if(path==='/api/instructor/reports/progress'){
      const params=new URL(request.url).searchParams;
      const selected=members.filter(m=>(!params.get('classId')||m.class_id===Number(params.get('classId')))&&(!params.get('studentId')||m.student_id===params.get('studentId')));
      if(!selected.length) return {body:[]};
      const ids=[...new Set(selected.map(m=>m.student_id))];
      const users=await checked(admin().from('profiles').select('id,username,display_name').in('id',ids));
      const progress=await checked(admin().from('mission_progress').select('*').in('student_id',ids));
      const points=await checked(admin().from('point_transactions').select('student_id,amount').in('student_id',ids));
      return {body:selected.map(m=>({classId:m.class_id,className:classes.find(c=>c.id===m.class_id)?.name,studentId:m.student_id,
        studentName:users.find(u=>u.id===m.student_id)?.display_name,studentUsername:users.find(u=>u.id===m.student_id)?.username,
        missionsCompleted:progress.filter(p=>p.student_id===m.student_id&&p.status==='completed').length,
        missionsInProgress:progress.filter(p=>p.student_id===m.student_id&&p.status==='in_progress').length,
        totalPoints:points.filter(p=>p.student_id===m.student_id).reduce((sum,p)=>sum+p.amount,0),
        lastActivity:progress.filter(p=>p.student_id===m.student_id).map(p=>p.completed_at??p.started_at).sort().at(-1)??null}))};
    }
    if(path==='/api/instructor/dashboard') return {body:{totalClasses:classes.length,totalStudents:new Set(members.map(m=>m.student_id)).size,
      activeClasses:classes.filter(c=>members.some(m=>m.class_id===c.id)).length,activeAssignments:assignments.filter(a=>a.status==='published').length,
      pendingSubmissions:submissions.filter(s=>s.status==='submitted').length,classes:classes.map(classDto),
      recentActivity:submissions.filter(s=>s.status==='submitted').sort((a,b)=>b.submitted_at.localeCompare(a.submitted_at)).slice(0,5)
        .map(s=>({studentId:s.student_id,assignmentTitle:assignments.find(a=>a.id===s.assignment_id)?.title,status:s.status,submittedAt:s.submitted_at}))}};
    if(path==='/api/instructor/classes'||path==='/api/classes/me') return {body:classes.map(classDto)};
    if(path==='/api/instructor/assignments'||path==='/api/student/assignments') return {body:assignments.map(assignmentDto)};
    const classMatch=path.match(/^\/api\/instructor\/classes\/(\d+)(?:\/(students|available-students))?$/);
    if(classMatch){
      const selected=classes.find(c=>c.id===Number(classMatch[1]));
      if(!selected) return {body:{error:'Class not found'},status:404};
      const mine=members.filter(member=>member.class_id===selected.id);
      const students=await checked(admin().from('profiles').select('id,username,display_name,created_at').eq('role','student').eq('account_status','active'));
      const studentDtos=students.map(student=>({id:student.id,userName:student.username,displayName:student.display_name,email:'',joinedAt:mine.find(m=>m.student_id===student.id)?.joined_at}));
      if(classMatch[2]==='students') return {body:studentDtos.filter(s=>mine.some(m=>m.student_id===s.id))};
      if(classMatch[2]==='available-students'){
        const query=new URL(request.url).searchParams.get('q')?.toLowerCase()??'';
        return {body:studentDtos.filter(s=>!mine.some(m=>m.student_id===s.id)&&`${s.userName} ${s.displayName}`.toLowerCase().includes(query)).slice(0,100)};
      }
      return {body:{...camel(selected),students:studentDtos.filter(s=>mine.some(m=>m.student_id===s.id)),assignments:assignments.filter(a=>a.class_id===selected.id).map(assignmentDto)}};
    }
    const assignmentMatch=path.match(/^\/api\/(?:instructor|student)\/assignments\/(\d+)(\/submissions)?$/);
    if(assignmentMatch){
      const assignment=assignments.find(a=>a.id===Number(assignmentMatch[1]));
      if(!assignment) return {body:{error:'Assignment not found'},status:404};
      if(assignmentMatch[2]){
        if(!staff) return {body:{error:'Instructor access required'},status:403};
        const users=await checked(admin().from('profiles').select('id,username,display_name').in('id',members.filter(m=>m.class_id===assignment.class_id).map(m=>m.student_id)));
        return {body:submissions.filter(s=>s.assignment_id===assignment.id).map(s=>({...camel(s),studentUsername:users.find(u=>u.id===s.student_id)?.username,studentDisplayName:users.find(u=>u.id===s.student_id)?.display_name}))};
      }
      return {body:assignmentDto(assignment)};
    }
  }
  const raw=await request.text();if(raw.length>50000) return {body:{error:'Request too large'},status:413};
  let body;try{body=raw?JSON.parse(raw):{};}catch{return {body:{error:'Invalid JSON'},status:400};}
  if(path==='/api/classes/join'&&request.method==='POST'){
    if(typeof body.joinCode!=='string'||body.joinCode.length>32) return {body:{error:'Invalid join code'},status:400};
    const id=await checked(client.rpc('join_class',{p_code:body.joinCode}));return {body:{classId:id}};
  }
  const submit=path.match(/^\/api\/student\/assignments\/(\d+)\/submit$/);
  if(submit&&request.method==='POST'){
    if(body.notes!=null&&typeof body.notes!=='string') return {body:{error:'Invalid notes'},status:400};
    const id=await checked(client.rpc('submit_assignment',{p_assignment:Number(submit[1]),p_notes:body.notes??null}));return {body:{id}};
  }
  const classMutation=path.match(/^\/api\/instructor\/classes(?:\/(\d+))?(?:\/(join-code|students)(?:\/([a-f0-9-]+))?)?$/);
  if(classMutation){
    const id=classMutation[1]?Number(classMutation[1]):null;
    if(id&&!classes.some(c=>c.id===id)) return {body:{error:'Class not found'},status:404};
    if(classMutation[2]==='join-code'&&request.method==='POST'){
      const joinCode=Array.from(crypto.getRandomValues(new Uint8Array(6)),byte=>byte.toString(16).padStart(2,'0')).join('').toUpperCase();
      const expiresAt=new Date(Date.now()+7*86400000).toISOString();
      await checked(client.from('classes').update({join_code:joinCode,join_code_expires_at:expiresAt}).eq('id',id));return {body:{joinCode,expiresAt}};
    }
    if(classMutation[2]==='students'){
      if(request.method==='DELETE'&&classMutation[3]){await checked(client.from('class_memberships').delete().eq('class_id',id).eq('student_id',classMutation[3]));return {body:{deleted:true}};}
      if(request.method==='POST'){
        if(!Array.isArray(body.studentIds)||body.studentIds.length>100||!body.studentIds.every((value:unknown)=>typeof value==='string'&&/^[0-9a-f-]{36}$/.test(value))) return {body:{error:'Invalid student list'},status:400};
        const valid=await checked(admin().from('profiles').select('id').in('id',body.studentIds).eq('role','student').eq('account_status','active'));
        if(valid.length!==new Set(body.studentIds).size) return {body:{error:'Student not found'},status:400};
        // The class was loaded through caller RLS above; service access only inserts verified students.
        const added=await checked(admin().from('class_memberships').upsert(valid.map(s=>({class_id:id,student_id:s.id})),{onConflict:'class_id,student_id',ignoreDuplicates:true}).select('id'));
        return {body:{added:added.length}};
      }
    }
    if(request.method==='DELETE'&&id){await checked(client.from('classes').delete().eq('id',id));return {body:{deleted:true}};}
    if(['POST','PUT'].includes(request.method)&&!classMutation[2]){
      if(typeof body.name!=='string'||!body.name.trim()||body.name.length>200||body.description!=null&&(typeof body.description!=='string'||body.description.length>5000)) return {body:{error:'Invalid class details'},status:400};
      const values={name:body.name.trim(),description:body.description??null,updated_at:new Date().toISOString()};
      const query=id?client.from('classes').update(values).eq('id',id):client.from('classes').insert({...values,instructor_id:userId});
      return {body:await checked(query.select('id').single())};
    }
  }
  const assignmentMutation=path.match(/^\/api\/instructor\/assignments(?:\/(\d+))?$/);
  if(assignmentMutation){
    const id=assignmentMutation[1]?Number(assignmentMutation[1]):null;
    if(id&&!assignments.some(a=>a.id===id)) return {body:{error:'Assignment not found'},status:404};
    if(request.method==='DELETE'&&id){
      if(submissions.some(s=>s.assignment_id===id)){await checked(client.from('assignments').update({status:'closed'}).eq('id',id));return {body:{closed:true,message:'Assignment closed to preserve submissions.'}};}
      await checked(client.from('assignments').delete().eq('id',id));return {body:{deleted:true}};
    }
    if(['POST','PUT'].includes(request.method)){
      const previous=assignments.find(a=>a.id===id);const title=body.title??previous?.title;const classId=body.classId??previous?.class_id;
      if(typeof title!=='string'||!title.trim()||title.length>200||!classes.some(c=>c.id===classId)) return {body:{error:'Enter a title and select a class'},status:400};
      if(body.missionIds!==undefined&&(!Array.isArray(body.missionIds)||!body.missionIds.every((n:unknown)=>Number.isInteger(n)&&Number(n)>=1&&Number(n)<=18))) return {body:{error:'Invalid missions'},status:400};
      if(body.status!==undefined&&!['draft','published','closed'].includes(body.status)) return {body:{error:'Invalid status'},status:400};
      if(body.deadline&&isNaN(Date.parse(body.deadline))) return {body:{error:'Invalid deadline'},status:400};
      if(body.description!=null&&(typeof body.description!=='string'||body.description.length>10000)) return {body:{error:'Invalid description'},status:400};
      const values={title:title.trim(),class_id:classId,description:body.description??previous?.description??null,mission_ids:body.missionIds??previous?.mission_ids??[],deadline:body.deadline??previous?.deadline??null,status:body.status??previous?.status??'draft',updated_at:new Date().toISOString()};
      const query=id?client.from('assignments').update(values).eq('id',id):client.from('assignments').insert({...values,instructor_id:userId});
      return {body:await checked(query.select('id').single())};
    }
  }
  const grade=path.match(/^\/api\/instructor\/submissions\/(\d+)\/grade$/);
  if(grade&&request.method==='POST'){
    if(!Number.isInteger(body.score)||body.score<0||body.score>100||body.feedback!=null&&typeof body.feedback!=='string') return {body:{error:'Invalid grade'},status:400};
    await checked(client.rpc('grade_submission',{p_submission:Number(grade[1]),p_score:body.score,p_feedback:body.feedback??null}));return {body:{graded:true}};
  }
  return null;
}
