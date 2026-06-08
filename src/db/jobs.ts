import { exec, newId, now, query, queryOne } from "./index.js";

export type DbJob = {
  id: string;
  project_id: string;
  type: string;
  status: string;
  progress: number;
  progress_total: number;
  progress_label: string;
  error: string | null;
  created_at: number;
  updated_at: number;
};

export async function createJob(projectId: string, type: string): Promise<DbJob> {
  const id = newId();
  const ts = now();
  await exec(
    `INSERT INTO jobs (id, project_id, type, status, progress, progress_total, progress_label, created_at, updated_at)
     VALUES ($1, $2, $3, 'pending', 0, 0, '', $4, $4)`,
    [id, projectId, type, ts],
  );
  return (await getJobById(id))!;
}

export async function getJobById(id: string): Promise<DbJob | null> {
  return queryOne<DbJob>(`SELECT * FROM jobs WHERE id = $1`, [id]);
}

export async function claimNextPendingJob(): Promise<DbJob | null> {
  const job = await queryOne<DbJob>(
    `SELECT * FROM jobs WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1`,
  );
  if (!job) return null;
  await exec(
    `UPDATE jobs SET status = 'running', updated_at = $1 WHERE id = $2 AND status = 'pending'`,
    [now(), job.id],
  );
  return getJobById(job.id);
}

export async function updateJobProgress(
  id: string,
  progress: number,
  progressTotal: number,
  label: string,
): Promise<void> {
  await exec(
    `UPDATE jobs SET progress = $1, progress_total = $2, progress_label = $3, updated_at = $4 WHERE id = $5`,
    [progress, progressTotal, label, now(), id],
  );
}

export async function completeJob(id: string): Promise<void> {
  await exec(`UPDATE jobs SET status = 'done', updated_at = $1 WHERE id = $2`, [now(), id]);
}

export async function failJob(id: string, error: string): Promise<void> {
  await exec(`UPDATE jobs SET status = 'failed', error = $1, updated_at = $2 WHERE id = $3`, [
    error,
    now(),
    id,
  ]);
}

export async function listJobsForProject(projectId: string): Promise<DbJob[]> {
  return query<DbJob>(
    `SELECT * FROM jobs WHERE project_id = $1 ORDER BY created_at DESC`,
    [projectId],
  );
}
