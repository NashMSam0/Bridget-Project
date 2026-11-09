import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

export async function projectsRoute(client: SupabaseClient, userId: string, path: string,
  request: Request): Promise<{ body: unknown; status?: number } | null> {
  if (!/^\/api\/projects(?:\/|$)/.test(path)) return null;
  const match = path.match(/^\/api\/projects\/(\d+)(\/duplicate)?$/);
  const id = match ? Number(match[1]) : null;
  const dto = (row: Record<string, unknown>) => ({ id: row.id, title: row.title,
    description: row.description, content: row.content, status: row.status,
    createdAt: row.created_at, updatedAt: row.updated_at,
    versionCount: (row.project_versions as {count:number}[] | undefined)?.[0]?.count ?? 0 });
  const select = '*,project_versions(count)';
  if (request.method === 'GET' && path === '/api/projects/me') {
    const { data, error } = await client.from('projects').select(select).eq('student_id',userId).order('updated_at',{ascending:false});
    if(error) throw error;
    return { body: data.map(dto) };
  }
  if (id && request.method === 'GET') {
    const { data, error } = await client.from('projects').select(select).eq('id',id).eq('student_id',userId).maybeSingle();
    if(error) throw error;
    return data ? { body: dto(data) } : { body:{error:'Project not found'}, status:404 };
  }
  if (id && request.method === 'DELETE' && !match?.[2]) {
    const { data,error } = await client.from('projects').delete().eq('id',id).eq('student_id',userId).select('id');
    if(error) throw error;
    return data.length ? { body:null, status:200 } : { body:{error:'Project not found'},status:404 };
  }
  if (!['POST','PUT'].includes(request.method)) return {body:{error:'Method not allowed'},status:405};
  const raw = await request.text();
  if(raw.length > 1100000) return {body:{error:'Project too large'},status:413};
  let body;
  try { body = raw ? JSON.parse(raw) : {}; } catch { return {body:{error:'Invalid JSON'},status:400}; }
  if(id && match?.[2] && request.method === 'POST') {
    const {data,error} = await client.from('projects').select('*').eq('id',id).eq('student_id',userId).maybeSingle();
    if(error) throw error;
    if(!data) return {body:{error:'Project not found'},status:404};
    body = {title: String(data.title).slice(0,190)+' (copy)',description:data.description,content:data.content};
  } else if(path !== '/api/projects' && !(id && request.method === 'PUT')) {
    return {body:{error:'Route not found'},status:404};
  }
  if ((request.method === 'POST' || body.title !== undefined) &&
    (typeof body.title !== 'string' || !body.title.trim() || body.title.length>200))
    return {body:{error:'Title must contain 1–200 characters'},status:400};
  if(body.content !== undefined && (typeof body.content !== 'string' || body.content.length>1000000))
    return {body:{error:'Invalid project content'},status:400};
  if(body.description !== undefined && body.description !== null && (typeof body.description !== 'string' || body.description.length>5000))
    return {body:{error:'Invalid description'},status:400};
  if(body.status !== undefined && !['draft','published','archived'].includes(body.status))
    return {body:{error:'Invalid status'},status:400};
  const values = Object.fromEntries(Object.entries({title:body.title?.trim(),description:body.description,content:body.content,status:body.status}).filter(([,value])=>value!==undefined));
  const query = request.method === 'PUT' ? client.from('projects').update({...values,updated_at:new Date().toISOString()}).eq('id',id).eq('student_id',userId)
    : client.from('projects').insert({...values,student_id:userId});
  const {data,error} = await query.select('id').maybeSingle();
  if(error) throw error;
  return data ? {body:data} : {body:{error:'Project not found'},status:404};
}
