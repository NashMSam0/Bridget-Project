import { supabase, supabaseSessionHeaders } from './supabase';

const configuredApiBaseUrl = supabase
  ? `${import.meta.env.VITE_SUPABASE_URL.replace(/\/+$/, '')}/functions/v1/codebloom-api`
  : import.meta.env.VITE_API_BASE_URL?.trim();
const API_BASE_URL = configuredApiBaseUrl
  ? configuredApiBaseUrl.replace(/\/+$/, "")
  : import.meta.env.PROD
    ? ""
    : "http://localhost:5202";

function getApiConfigurationError(): string | null {
  if (!API_BASE_URL) {
    return (
      "The production API URL is not configured. In Vercel, open Project Settings > " +
      "Environment Variables and set VITE_API_BASE_URL to your deployed ASP.NET Core " +
      "API base URL, then redeploy the frontend."
    );
  }

  if (!import.meta.env.PROD) return null;

  let url: URL;
  try {
    url = new URL(API_BASE_URL);
  } catch {
    return "VITE_API_BASE_URL must be an absolute HTTPS URL for the deployed CodeBloom API.";
  }

  if (url.protocol !== "https:") {
    return "VITE_API_BASE_URL must use HTTPS in production.";
  }

  if (
    url.hostname === "localhost" ||
    url.hostname.endsWith(".localhost") ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "::1" ||
    url.hostname === "[::1]"
  ) {
    return "VITE_API_BASE_URL points to localhost, which is not reachable by visitors to the deployed site. Configure the publicly reachable HTTPS API URL in Vercel and redeploy.";
  }

  return null;
}

const API_CONFIGURATION_ERROR = getApiConfigurationError();

/** Error thrown by every API helper. `status` is the HTTP status code. */
export class ApiError extends Error {
  status: number;
  fieldErrors: Record<string, string[]> | null;

  constructor(
    message: string,
    status: number,
    fieldErrors: Record<string, string[]> | null = null,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.fieldErrors = fieldErrors;
  }
}

interface ErrorBody {
  title?: string;
  error?: string;
  message?: string;
  errors?: Record<string, string[]>;
}

async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  if (API_CONFIGURATION_ERROR) {
    throw new ApiError(API_CONFIGURATION_ERROR, 0);
  }

  const url = path.startsWith("http") ? path : `${API_BASE_URL}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(await supabaseSessionHeaders()),
    ...(options.headers as Record<string, string> | undefined),
  };

  let res: Response;
  try {
    res = await fetch(url, {
      ...options,
      credentials: "include",
      headers,
    });
  } catch {
    throw new ApiError(
      `Could not reach the CodeBloom API at ${API_BASE_URL}. Confirm that the API is ` +
        "running and publicly reachable over HTTPS, and that its CORS allowed origins " +
        "include this frontend's exact origin. If frontend and API are on different " +
        "sites, authentication cookies may also require a same-site custom domain.",
      0,
    );
  }

  if (!res.ok) {
    let body: ErrorBody | null = null;
    try {
      body = (await res.json()) as ErrorBody;
    } catch {
      /* response was not JSON */
    }
    const fieldErrors = body?.errors ?? null;
    const firstFieldError = fieldErrors
      ? Object.values(fieldErrors).flat().find(Boolean)
      : undefined;
    throw new ApiError(
      body?.error ??
        body?.message ??
        firstFieldError ??
        body?.title ??
        `Request failed (${res.status})`,
      res.status,
      fieldErrors,
    );
  }

  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, {
      method: "POST",
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, {
      method: "PUT",
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};

// ------------------------------------------------------------------
// Auth
// ------------------------------------------------------------------

export interface RegisterInput {
  displayName: string;
  username: string;
  email: string;
  password: string;
  role: "student" | "instructor";
  character: "boy" | "girl";
  ageGroup?: string;
}

export interface LoginInput {
  usernameOrEmail: string;
  password: string;
}

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  email: string;
  role: string;
  accountStatus: string;
  createdAt: string;
}

export async function registerUser(
  input: RegisterInput,
): Promise<{ user: AuthUser; expiresAt: string }> {
  if (supabase) {
    if (input.role !== 'student') throw new ApiError('Instructor accounts must be approved by an administrator.', 403);
    const { data, error } = await supabase.auth.signUp({ email: input.email, password: input.password,
      options: { data: { username: input.username, displayName: input.displayName, character: input.character, ageGroup: input.ageGroup } } });
    if (error) throw new ApiError(error.message, 400);
    if (!data.session) throw new ApiError('Check your email to confirm your account, then sign in.', 400);
    return { user: await getCurrentUser(), expiresAt: new Date(data.session.expires_at! * 1000).toISOString() };
  }
  return api.post("/api/auth/register", input);
}

export async function loginUser(
  input: LoginInput,
): Promise<{ user: AuthUser; expiresAt: string }> {
  if (supabase) {
    const { data, error } = await supabase.auth.signInWithPassword({ email: input.usernameOrEmail.trim(), password: input.password });
    if (error) throw new ApiError(error.message, 401);
    return { user: await getCurrentUser(), expiresAt: new Date(data.session.expires_at! * 1000).toISOString() };
  }
  // The backend field is `username`, but the UI labels it "email or username";
  // AuthService resolves either value on the server.
  return api.post("/api/auth/login", {
    username: input.usernameOrEmail.trim(),
    password: input.password,
  });
}

/**
 * Sends a Firebase ID token to the API. The server verifies it with the Firebase
 * Admin SDK, resolves the role from SQL Server and sets the usual HttpOnly cookie.
 */
export async function exchangeFirebaseToken(
  idToken: string,
): Promise<{ user: AuthUser; expiresAt: string; provider: string }> {
  return api.post("/api/auth/firebase", { idToken });
}

export interface FirebaseStatus {
  provider: "firebase";
  enabled: boolean;
  reason: string | null;
}

export async function getFirebaseStatus(): Promise<FirebaseStatus> {
  return api.get("/api/auth/firebase/status");
}

export async function logoutUser(): Promise<void> {
  if (supabase) {
    const { error } = await supabase.auth.signOut();
    if (error) throw new ApiError(error.message, 400);
    return;
  }
  await api.post("/api/auth/logout");
}

export async function getCurrentUser(): Promise<AuthUser> {
  return api.get("/api/auth/me");
}

// ------------------------------------------------------------------
// Students / Profile
// ------------------------------------------------------------------

export interface StudentProfileDto {
  userId: string;
  displayName: string;
  username: string;
  character: string;
  ageGroup?: string;
  currentLevel: number;
  totalPoints: number;
  preferencesJson?: string;
}

export interface DashboardSummaryDto {
  displayName: string;
  character: string;
  totalPoints: number;
  missionsCompleted: number;
  missionsInProgress: number;
  missionsAvailable: number;
  missionsLocked: number;
  achievementsEarned: number;
  totalAchievements: number;
  totalMissions: number;
  availableMissions: MissionDto[];
  inProgressMissions: MissionDto[];
  lockedMissions: MissionDto[];
  recentAchievements: StudentAchievementDto[];
}

export interface StudentPreferences {
  sound: boolean;
  reducedMotion: boolean;
  showHints: boolean;
}

export async function getStudentProfile(): Promise<StudentProfileDto> {
  return api.get("/api/students/me");
}

export async function getDashboard(): Promise<DashboardSummaryDto> {
  return api.get("/api/students/me/dashboard");
}

export async function updateCharacter(
  character: "boy" | "girl",
): Promise<{ character: string }> {
  return api.put("/api/students/me/character", { character });
}

export async function updatePreferences(
  preferences: StudentPreferences,
): Promise<{ preferencesJson: string }> {
  return api.put("/api/students/me/preferences", preferences);
}

// ------------------------------------------------------------------
// Worlds & Missions
// ------------------------------------------------------------------

export interface WorldDto {
  id: number;
  key: string;
  name: string;
  tagline: string;
  description?: string;
  order: number;
  isPublished: boolean;
}

export interface MissionHintDto {
  id: number;
  hintText: string;
  order: number;
}

export interface MissionDto {
  id: number;
  worldId: number;
  key: string;
  title: string;
  description?: string;
  learningConcept?: string;
  difficulty: string;
  order: number;
  version: number;
  isPublished: boolean;
  isArchived: boolean;
  prerequisiteKeys: string[];
  hints: MissionHintDto[];
}

export interface MissionDetailDto extends MissionDto {
  configJson?: string;
  maxSteps: number;
  status: string;
  bestScore: number;
  hintsUsed: number;
  savedGameStateJson?: string;
  checkpoint?: string;
  testCases: Array<{
    id: number;
    name: string;
    inputJson?: string;
    order: number;
  }>;
}

export interface MissionMapItemDto {
  id: number;
  key: string;
  title: string;
  description?: string;
  learningConcept?: string;
  difficulty: string;
  order: number;
  status: string;
  bestScore: number;
}

export interface WorldMapDto {
  id: number;
  key: string;
  name: string;
  tagline: string;
  description?: string;
  order: number;
  missions: MissionMapItemDto[];
}

export async function getWorlds(): Promise<WorldDto[]> {
  return api.get("/api/worlds");
}

export async function getWorldLevels(worldId: number): Promise<unknown[]> {
  return api.get(`/api/worlds/${worldId}/levels`);
}

export async function getWorldMissions(worldId: number): Promise<MissionDto[]> {
  return api.get(`/api/worlds/${worldId}/missions`);
}

export async function getMission(missionId: number): Promise<MissionDetailDto> {
  return api.get(`/api/missions/${missionId}`);
}

export async function getMissionHints(
  missionId: number,
): Promise<MissionHintDto[]> {
  return api.get(`/api/missions/${missionId}/hints`);
}

export async function getMissionMap(): Promise<WorldMapDto[]> {
  return api.get("/api/missions/map");
}

// ------------------------------------------------------------------
// Progress
// ------------------------------------------------------------------

export interface MissionProgressDto {
  missionId: number;
  missionTitle?: string;
  worldId?: number;
  status: string;
  attempts: number;
  bestScore: number;
  latestScore: number;
  pointsEarned: number;
  hintsUsed: number;
  startedAt?: string | null;
  completedAt?: string | null;
  savedGameStateJson?: string | null;
  checkpoint?: string | null;
}

export interface SubmitMissionRequest {
  programJson: string;
  durationSeconds?: number;
}

export interface SubmitMissionResponse {
  success: boolean;
  score: number;
  maxScore: number;
  result: string;
  message: string;
  attempts: number;
  firstCompletion: boolean;
  pointsEarned: number;
  totalPoints: number;
  newAchievement: boolean;
  newAchievementTitle?: string;
  nextMissionId?: number;
  nextMissionKey?: string;
  progress: MissionProgressDto;
}

export interface MissionAttemptDto {
  id: number;
  attemptNumber: number;
  score: number;
  result: string;
  hintsUsed: number;
  durationSeconds?: number;
  createdAt: string;
}

export interface CheckpointRequest {
  gameStateJson?: string;
  checkpoint?: string;
  hintsUsed?: number;
  timeSpentSeconds?: number;
}

export async function getProgressRecords(): Promise<MissionProgressDto[]> {
  return api.get("/api/progress/me");
}

export async function startMission(
  missionId: number,
): Promise<MissionProgressDto> {
  return api.post(`/api/progress/${missionId}/start`);
}

export async function saveCheckpoint(
  missionId: number,
  request: CheckpointRequest,
): Promise<MissionProgressDto> {
  return api.put(`/api/progress/${missionId}/checkpoint`, request);
}

export async function submitMission(
  missionId: number,
  request: SubmitMissionRequest,
): Promise<SubmitMissionResponse> {
  return api.post(`/api/progress/${missionId}/submit`, request);
}

export async function getAttempts(
  missionId: number,
): Promise<MissionAttemptDto[]> {
  return api.get(`/api/progress/${missionId}/attempts`);
}

// ------------------------------------------------------------------
// Achievements & Points
// ------------------------------------------------------------------

export interface AchievementDto {
  id: number;
  key: string;
  title: string;
  description?: string;
  icon?: string;
  criteria?: string;
  rewardPoints: number;
  isActive: boolean;
  earned: boolean;
  earnedAt?: string;
}

export interface StudentAchievementDto {
  id: number;
  achievementId: number;
  title: string;
  icon?: string;
  rewardPoints: number;
  earnedAt: string;
}

export interface PointTransactionDto {
  id: number;
  amount: number;
  type: string;
  missionId?: number;
  createdAt: string;
}

export async function getStudentAchievements(): Promise<AchievementDto[]> {
  return api.get("/api/achievements/me");
}

export async function getPointTransactions(): Promise<PointTransactionDto[]> {
  return api.get("/api/points/me");
}

// ------------------------------------------------------------------
// AI Assistant
// ------------------------------------------------------------------

export interface AiChatRequest {
  message: string;
  missionKey?: string;
  programJson?: string;
}

export interface AiChatResponse {
  reply: string;
  disabled: boolean;
  reason?: string;
}

export async function sendAiMessage(
  request: AiChatRequest,
): Promise<AiChatResponse> {
  return api.post("/api/ai/assistant/chat", request);
}

// ------------------------------------------------------------------
// Projects (Creator Lab)
// ------------------------------------------------------------------

export interface ProjectDto {
  id: number;
  title: string;
  description?: string;
  content: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  versionCount: number;
}

export interface CreateProjectRequest {
  title: string;
  description?: string;
  content: string;
}

export interface UpdateProjectRequest {
  title?: string;
  description?: string;
  content?: string;
  status?: string;
}

export async function getProjects(): Promise<ProjectDto[]> {
  return api.get("/api/projects/me");
}

export async function getProject(id: number): Promise<ProjectDto> {
  return api.get(`/api/projects/${id}`);
}

export async function createProject(
  request: CreateProjectRequest,
): Promise<{ id: number }> {
  return api.post("/api/projects", request);
}

export async function updateProject(
  id: number,
  request: UpdateProjectRequest,
): Promise<{ id: number }> {
  return api.put(`/api/projects/${id}`, request);
}

export async function deleteProject(id: number): Promise<void> {
  await api.delete(`/api/projects/${id}`);
}

export async function duplicateProject(id: number): Promise<{ id: number }> {
  return api.post(`/api/projects/${id}/duplicate`);
}

// ------------------------------------------------------------------
// Game library (free play, separate from guided mission progress)
// ------------------------------------------------------------------

export interface GameDto {
  id: number;
  key: string;
  title: string;
  tagline?: string | null;
  description: string;
  genre: string;
  difficulty: string;
  skills: string[];
  estimatedMinutes: number;
  backgroundKey: string;
  objective: string;
  isFeatured: boolean;
  order: number;
  sceneJson: string;
  starterBlocksJson?: string | null;
  allowedBlocks?: string[] | null;
  hints?: string[] | null;
  playCount?: number | null;
  completed?: boolean | null;
  bestScore?: number | null;
  lastPlayedAt?: string | null;
}

export interface RecentGameDto {
  gameId: number;
  playCount: number;
  completed: boolean;
  bestScore: number;
  lastPlayedAt: string;
  key: string;
  title: string;
  genre: string;
  difficulty: string;
  backgroundKey: string;
  sceneJson: string;
}

export interface GamePlaySessionDto {
  playCount: number;
  completed: boolean;
  bestScore: number;
}

export interface GameCompletionResultDto {
  completed: boolean;
  bestScore: number;
  firstCompletion: boolean;
  playCount: number;
}

export async function getGames(): Promise<GameDto[]> {
  return api.get("/api/games");
}

export async function getRecentGames(): Promise<RecentGameDto[]> {
  return api.get("/api/games/recent");
}

export async function getGame(id: number): Promise<GameDto> {
  return api.get(`/api/games/${id}`);
}

export async function startGamePlay(id: number): Promise<GamePlaySessionDto> {
  return api.post(`/api/games/${id}/play`);
}

export async function completeGame(
  id: number,
  score: number,
  skills?: string[],
): Promise<GameCompletionResultDto> {
  return api.post(`/api/games/${id}/complete`, { score, skills });
}

// ------------------------------------------------------------------
// Ready-made game missions and persistent learner progress
// ------------------------------------------------------------------

export interface GameMissionDto {
  id: number;
  gameId: number;
  key: string;
  title: string;
  description: string;
  objective: string;
  difficulty: string;
  concepts: string[];
  completionCriteriaJson: string;
  configJson: string;
  points: number;
  starsAvailable: number;
  order: number;
  bestStars: number;
  bestScore: number;
  attempts: number;
  completed: boolean;
  bestTimeSeconds?: number | null;
}

export interface GameProgressDto {
  gameId: number;
  gameKey: string;
  currentMissionId?: number | null;
  currentMissionKey?: string | null;
  totalScore: number;
  totalStars: number;
  missionsCompleted: number;
  attempts: number;
  firstPlayedAt?: string | null;
  lastPlayedAt: string;
}

export interface GameMissionListDto {
  missions: GameMissionDto[];
  progress?: GameProgressDto | null;
  totalMissions: number;
  completedMissions: number;
  totalStars: number;
  starsAvailable: number;
}

export interface StartGameMissionResultDto {
  attemptNumber: number;
  bestStars: number;
  completed: boolean;
}

export interface CompleteGameMissionRequest {
  score: number;
  stars: number;
  timeTakenSeconds?: number;
  blocksUsed: number;
  programJson?: string;
}

export interface GameMissionResultDto {
  completed: boolean;
  firstCompletion: boolean;
  stars: number;
  bestStars: number;
  score: number;
  bestScore: number;
  pointsAwarded: number;
  totalPoints: number;
  totalStars: number;
  missionsCompleted: number;
  attempts: number;
  newAchievement: boolean;
  newAchievementTitle?: string | null;
  newAchievements: string[];
}

export async function getGameMissions(gameId: number): Promise<GameMissionListDto> {
  return api.get(`/api/games/${gameId}/missions`);
}

export async function getGamesProgress(): Promise<GameProgressDto[]> {
  return api.get("/api/games/progress");
}

export async function startGameMission(
  gameId: number,
  missionId: number,
): Promise<StartGameMissionResultDto> {
  return api.post(`/api/games/${gameId}/missions/${missionId}/start`);
}

export async function completeGameMission(
  gameId: number,
  missionId: number,
  request: CompleteGameMissionRequest,
): Promise<GameMissionResultDto> {
  return api.post(`/api/games/${gameId}/missions/${missionId}/complete`, request);
}

// ------------------------------------------------------------------
// Instructor
// ------------------------------------------------------------------

export interface ClassDto {
  id: number;
  name: string;
  description?: string;
  studentCount: number;
  createdAt: string;
}

export interface CreateClassRequest {
  name: string;
  description?: string;
}

export interface InstructorStudentDto {
  id: string;
  userName: string;
  email: string;
  displayName?: string;
  joinedAt?: string;
}

export interface InstructorClassDetailDto {
  id: number;
  name: string;
  description?: string;
  joinCode?: string | null;
  joinCodeExpiresAt?: string | null;
  createdAt: string;
  updatedAt: string;
  assignments: Array<{
    id: number;
    title: string;
    status: string;
    deadline?: string | null;
  }>;
  students: InstructorStudentDto[];
}

export interface AssignmentDto {
  id: number;
  title: string;
  description?: string;
  classId?: number | null;
  className?: string | null;
  deadline?: string | null;
  status: string;
  submissionCount: number;
  missionIds: number[];
  createdAt: string;
  submissionStatus?: string;
  studentScore?: number | null;
  studentFeedback?: string | null;
  studentNotes?: string | null;
  studentSubmittedAt?: string | null;
  isOverdue?: boolean;
}

export interface CreateAssignmentRequest {
  title: string;
  description?: string;
  classId?: number;
  missionIds: number[];
  deadline?: string;
}

export interface UpdateAssignmentRequest {
  title?: string;
  description?: string;
  classId?: number;
  missionIds?: number[];
  deadline?: string;
  status?: string;
}

export interface InstructorDashboardDto {
  totalClasses: number;
  totalStudents: number;
  activeClasses: number;
  activeAssignments: number;
  pendingSubmissions: number;
  recentActivity: Array<{
    studentId: string;
    assignmentTitle: string;
    status: string;
    submittedAt: string | null;
  }>;
  classes: ClassDto[];
}

export async function getInstructorDashboard(): Promise<InstructorDashboardDto> {
  return api.get("/api/instructor/dashboard");
}

export async function getInstructorClasses(): Promise<ClassDto[]> {
  return api.get("/api/instructor/classes");
}

export async function getInstructorClass(
  classId: number,
): Promise<InstructorClassDetailDto> {
  return api.get(`/api/instructor/classes/${classId}`);
}

export async function createClass(
  request: CreateClassRequest,
): Promise<{ id: number }> {
  return api.post("/api/instructor/classes", request);
}

export async function updateClass(
  classId: number,
  request: { name?: string; description?: string },
): Promise<{ id: number }> {
  return api.put(`/api/instructor/classes/${classId}`, request);
}

export async function deleteClass(classId: number): Promise<void> {
  await api.delete(`/api/instructor/classes/${classId}`);
}

export async function getClassStudents(
  classId: number,
): Promise<InstructorStudentDto[]> {
  return api.get(`/api/instructor/classes/${classId}/students`);
}

export async function getAvailableStudents(
  classId: number,
  query?: string,
): Promise<InstructorStudentDto[]> {
  const params = query ? `?q=${encodeURIComponent(query)}` : "";
  return api.get(`/api/instructor/classes/${classId}/available-students${params}`);
}

export async function addStudentsToClass(
  classId: number,
  studentIds: string[],
): Promise<{ added: number }> {
  return api.post(`/api/instructor/classes/${classId}/students`, { studentIds });
}

export async function removeStudentFromClass(
  classId: number,
  studentId: string,
): Promise<void> {
  await api.delete(`/api/instructor/classes/${classId}/students/${studentId}`);
}

export async function generateJoinCode(
  classId: number,
): Promise<{ joinCode: string; expiresAt: string }> {
  return api.post(`/api/instructor/classes/${classId}/join-code`);
}

export async function createAssignment(
  request: CreateAssignmentRequest,
): Promise<{ id: number }> {
  return api.post("/api/instructor/assignments", request);
}

export async function getInstructorAssignments(): Promise<AssignmentDto[]> {
  return api.get("/api/instructor/assignments");
}

export async function getInstructorAssignment(
  assignmentId: number,
): Promise<AssignmentDto> {
  return api.get(`/api/instructor/assignments/${assignmentId}`);
}

export async function updateAssignment(
  assignmentId: number,
  request: UpdateAssignmentRequest,
): Promise<{ id: number }> {
  return api.put(`/api/instructor/assignments/${assignmentId}`, request);
}

export async function deleteAssignment(
  assignmentId: number,
): Promise<{ deleted?: boolean; closed?: boolean; message?: string }> {
  return api.delete(`/api/instructor/assignments/${assignmentId}`);
}

export interface SubmissionDto {
  id: number;
  studentId: string;
  studentUsername: string;
  studentDisplayName?: string;
  status: string;
  score?: number | null;
  feedback?: string | null;
  notes?: string | null;
  submittedAt?: string | null;
}

export async function getAssignmentSubmissions(
  assignmentId: number,
): Promise<SubmissionDto[]> {
  return api.get(`/api/instructor/assignments/${assignmentId}/submissions`);
}

export async function gradeSubmission(
  submissionId: number,
  score?: number,
  feedback?: string,
): Promise<{ graded: boolean }> {
  return api.post(`/api/instructor/submissions/${submissionId}/grade`, {
    score,
    feedback,
  });
}

export interface ProgressReportDto {
  classId: number;
  className: string;
  studentId: string;
  studentName: string;
  studentUsername: string;
  missionsCompleted: number;
  missionsInProgress: number;
  totalPoints: number;
  lastActivity?: string | null;
}

export async function getInstructorProgressReports(
  classId?: number,
  studentId?: string,
): Promise<ProgressReportDto[]> {
  const params = new URLSearchParams();
  if (classId !== undefined) params.set("classId", classId.toString());
  if (studentId) params.set("studentId", studentId);
  const query = params.toString() ? `?${params}` : "";
  return api.get(`/api/instructor/reports/progress${query}`);
}

// ------------------------------------------------------------------
// Student classes / assignments
// ------------------------------------------------------------------

export interface StudentClassDto {
  id: number;
  name: string;
  description?: string;
  instructor: string;
  joinedAt: string;
}

export async function getMyClasses(): Promise<StudentClassDto[]> {
  return api.get("/api/classes/me");
}

export async function joinClass(
  joinCode: string,
): Promise<{ classId: number; className: string }> {
  return api.post("/api/classes/join", { joinCode });
}

export async function getStudentAssignments(): Promise<AssignmentDto[]> {
  return api.get("/api/student/assignments");
}

export async function getStudentAssignment(
  assignmentId: number,
): Promise<AssignmentDto> {
  return api.get(`/api/student/assignments/${assignmentId}`);
}

export async function submitStudentAssignment(
  assignmentId: number,
  notes?: string,
): Promise<{ submitted: boolean; submissionId: number; submittedAt: string }> {
  return api.post(`/api/student/assignments/${assignmentId}/submit`, { notes });
}

// ------------------------------------------------------------------
// Admin
// ------------------------------------------------------------------

export interface UserListDto {
  id: string;
  username: string;
  email: string;
  displayName?: string;
  role: string;
  accountStatus: string;
  character?: string;
  totalPoints: number;
  createdAt: string;
}

export interface ChangeRoleRequest {
  role: string;
}

export interface MissionAdminDto {
  id: number;
  worldKey: string;
  key: string;
  title: string;
  difficulty: string;
  order: number;
  version: number;
  isPublished: boolean;
  isArchived: boolean;
}

export interface CreateMissionRequest {
  worldId: number;
  levelId?: number;
  key: string;
  title: string;
  description?: string;
  learningConcept?: string;
  difficulty?: string;
  configJson?: string;
  order: number;
  maxSteps?: number;
}

export interface UpdateMissionRequest {
  title?: string;
  description?: string;
  learningConcept?: string;
  difficulty?: string;
  configJson?: string;
  order?: number;
  maxSteps?: number;
}

export interface AnalyticsDto {
  totalUsers: number;
  totalStudents: number;
  totalInstructors: number;
  totalAdmins: number;
  totalMissions: number;
  totalMissionCompletions: number;
  totalAttempts: number;
  totalPointsAwarded: number;
  completionsByWorld: Record<string, number>;
}

export interface AuditLogDto {
  id: number;
  actorId?: string;
  actorRole?: string;
  eventType: string;
  target?: string;
  details?: string;
  createdAt: string;
}

export interface PlatformSettingDto {
  key: string;
  value?: string;
  description?: string;
}

export async function getAdminUsers(): Promise<UserListDto[]> {
  return api.get("/api/admin/users");
}

export async function changeUserRole(
  userId: string,
  request: ChangeRoleRequest,
): Promise<void> {
  await api.post(`/api/admin/users/${userId}/role`, request);
}

export async function changeUserStatus(
  userId: string,
  status: "active" | "suspended",
): Promise<void> {
  await api.post(`/api/admin/users/${userId}/status`, { status });
}

export async function getAdminWorlds(): Promise<WorldDto[]> {
  return api.get("/api/admin/worlds");
}

export async function getAdminMissions(): Promise<MissionAdminDto[]> {
  return api.get("/api/admin/missions");
}

export async function createAdminMission(
  request: CreateMissionRequest,
): Promise<MissionAdminDto> {
  return api.post("/api/admin/missions", request);
}

export async function updateAdminMission(
  id: number,
  request: UpdateMissionRequest,
): Promise<void> {
  await api.put(`/api/admin/missions/${id}`, request);
}

export async function publishMission(
  id: number,
  publish: boolean,
): Promise<void> {
  await api.post(`/api/admin/missions/${id}/publish`, { publish });
}

export async function archiveMission(id: number): Promise<void> {
  await api.post(`/api/admin/missions/${id}/archive`);
}

export async function getAdminAnalytics(): Promise<AnalyticsDto> {
  return api.get("/api/admin/analytics");
}

export async function getAuditLogs(): Promise<AuditLogDto[]> {
  return api.get("/api/admin/audit-logs");
}

export async function getPlatformSettings(): Promise<PlatformSettingDto[]> {
  return api.get("/api/admin/settings");
}

export async function updatePlatformSetting(
  key: string,
  value: string,
): Promise<{ key: string; value: string }> {
  return api.put("/api/admin/settings", { key, value });
}

// ------------------------------------------------------------------
// Python
// ------------------------------------------------------------------

export interface PythonRunRequest {
  code: string;
  stdin?: string;
}

export interface PythonRunResponse {
  success: boolean;
  output: string;
  error: string;
  exitCode: number;
  timedOut: boolean;
  available: boolean;
  reason?: string;
}

export async function runPython(
  request: PythonRunRequest,
): Promise<PythonRunResponse> {
  return api.post("/api/python/run", request);
}

export async function getPythonExercises(): Promise<unknown> {
  return api.get("/api/python/exercises");
}
