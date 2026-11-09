export interface MissionConfig {
  grid: { cols: number; rows: number };
  start: { x: number; y: number };
  goal: { x: number; y: number };
  obstacles?: { x: number; y: number }[];
  optimalBlocks?: number;
  scoring?: { main: number; efficiency: number; bonus: number };
}

export function executeMission(config: MissionConfig, programJson: string, maxSteps: number) {
  if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 10000) throw new Error('Invalid step limit');
  if(programJson.length>100000) throw new Error('Program is too large');
  const input: unknown=JSON.parse(programJson);
  if(!Array.isArray(input)||input.length>10000) throw new Error('Program must be an array of up to 10000 commands');
  const commands=input.map(command=>{
    if(!command||typeof command!=='object') return '';
    const type=command.type??command.Type;
    return typeof type==='string'?type.trim().toLowerCase():'';
  }).filter(type=>['move','turn_left','turn_right'].includes(type));
  if(!commands.length) throw new Error('Add at least one instruction block before running');
  const {grid,start,goal}=config;
  if(!grid||!start||!goal||![grid.cols,grid.rows,start.x,start.y,goal.x,goal.y].every(Number.isInteger)
    ||grid.cols<1||grid.rows<1||grid.cols>1000||grid.rows>1000
    ||[start,goal].some(point=>point.x<0||point.y<0||point.x>=grid.cols||point.y>=grid.rows)) throw new Error('Invalid mission geometry');
  const blocked=new Set((config.obstacles??[]).map(point=>`${point.x},${point.y}`));
  const directions=[[1,0],[0,1],[-1,0],[0,-1]];
  let x=start.x,y=start.y,facing=0,steps=0;
  for(const type of commands){
    if(steps>=maxSteps) break;
    steps++;
    if(type==='turn_left') facing=(facing+3)%4;
    else if(type==='turn_right') facing=(facing+1)%4;
    else {
      const nx=x+directions[facing][0],ny=y+directions[facing][1];
      if(nx>=0&&ny>=0&&nx<grid.cols&&ny<grid.rows&&!blocked.has(`${nx},${ny}`)){x=nx;y=ny;}
    }
  }
  return {reachedGoal:x===goal.x&&y===goal.y,finalX:x,finalY:y,finalFacing:facing,steps,
    stoppedEarly:commands.length>maxSteps,commandCount:commands.length,distanceToGoal:Math.abs(x-goal.x)+Math.abs(y-goal.y)};
}
