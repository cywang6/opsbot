// Copyright (c) 2026 Workflow Controller Contributors
//
// Licensed under the MIT License (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://opensource.org/licenses/MIT
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

export type AttributionKind = 'agent' | 'human' | 'automation' | 'unknown'

export type BlameLine = {
  line_no: number
  content: string
  actor_kind: AttributionKind | string
  actor_id?: string | null
  capture_id?: string | null
  session_id?: string | null
  runtime?: string | null
  model?: string | null
  agent_name?: string | null
  native_agent_id?: string | null
  conflict?: boolean
}

export type CommitMetrics = {
  commit_sha: string
  parent_sha?: string
  created_at?: string
  ai_lines: number
  total_added_lines: number
  generated_lines: number
  accepted_lines: number
  ai_share: number
  acceptance_rate: number
}

export type CommitRecord = Omit<CommitMetrics, 'ai_share' | 'acceptance_rate'>

export type CaptureSnapshot = {
  stage: 'before' | 'after'
  path: string
  content_blob: string
  attributions?: Array<Record<string, unknown>>
}

export type CaptureMutation = {
  path: string
  before_blob?: string | null
  after_blob?: string | null
  additions: number
  deletions: number
  conflict: boolean
}

export type CaptureRecord = {
  capture_id: string
  session_id?: string | null
  actor_kind: string
  native_session_id?: string | null
  parent_native_session_id?: string | null
  runtime?: string | null
  model?: string | null
  agent_name?: string | null
  native_agent_id?: string | null
  tool_name: string
  tool_use_id: string
  cwd: string
  started_at: string
  finished_at?: string | null
  succeeded?: boolean | null
  is_error?: boolean | null
  conflicted: boolean
  incomplete?: boolean | null
  tool_input: unknown
  tool_output: unknown
  attributes: Record<string, unknown>
  head_before?: string | null
  head_after?: string | null
  committed_sha?: string | null
  mutations: CaptureMutation[]
  snapshots: CaptureSnapshot[]
  conflicts: Array<{ kind: string; detail: string; created_at: string }>
}

export type CaptureFile = {
  capture_id: string
  stage: 'before' | 'after'
  path: string
  size: number
  binary: boolean
  content: string
  attributions: BlameLine[]
}

export class ProvenanceApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

function query(values: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== '') params.set(key, String(value))
  }
  return params.toString()
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  if (!response.ok) {
    let detail = `HTTP ${response.status}`
    const body = await response.text().catch(() => '')
    if (body) {
      try {
        const value = JSON.parse(body) as { detail?: unknown }
        detail = typeof value.detail === 'string' ? value.detail : body.slice(0, 240)
      } catch {
        detail = body.slice(0, 240)
      }
    }
    throw new ProvenanceApiError(detail, response.status)
  }
  return response.json() as Promise<T>
}

export async function listFiles(projectDir: string, commit = ''): Promise<string[]> {
  const result = await requestJson<{ files: string[] }>(
    `/api/provenance/files?${query({ project_dir: projectDir, commit })}`,
  )
  return result.files
}

export async function listCommits(projectDir: string): Promise<CommitRecord[]> {
  const result = await requestJson<{ commits: CommitRecord[] }>(
    `/api/provenance/commits?${query({ project_dir: projectDir })}`,
  )
  return result.commits
}

export async function getBlame(
  projectDir: string,
  path: string,
  commit = '',
): Promise<{ content_hash: string | null; lines: BlameLine[] }> {
  return requestJson<{ content_hash: string | null; lines: BlameLine[] }>(
    `/api/provenance/blame?${query({ project_dir: projectDir, path, commit })}`,
  )
}

export async function getMetrics(projectDir: string, commit = ''): Promise<CommitMetrics> {
  return requestJson<CommitMetrics>(
    `/api/provenance/metrics?${query({ project_dir: projectDir, commit })}`,
  )
}

export async function getCapture(
  projectDir: string,
  captureId: string,
): Promise<CaptureRecord> {
  return requestJson<CaptureRecord>(
    `/api/provenance/captures/${encodeURIComponent(captureId)}?${query({ project_dir: projectDir })}`,
  )
}

export async function getCaptureFile(
  projectDir: string,
  captureId: string,
  path: string,
  stage: 'before' | 'after',
): Promise<CaptureFile | null> {
  try {
    return await requestJson<CaptureFile>(
      `/api/provenance/captures/${encodeURIComponent(captureId)}/file?${query({ project_dir: projectDir, path, stage })}`,
    )
  } catch (error) {
    if (error instanceof ProvenanceApiError && error.status === 404) return null
    throw error
  }
}

export async function downloadAuditEvidence(
  projectDir: string,
  sessionId: string,
): Promise<Blob> {
  const response = await fetch(
    `/api/provenance/sessions/${encodeURIComponent(sessionId)}/audit-evidence?${query({ project_dir: projectDir })}`,
    { cache: 'no-store' },
  )
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new ProvenanceApiError(body.slice(0, 240) || `HTTP ${response.status}`, response.status)
  }
  return response.blob()
}

export async function claimHuman(body: {
  project_dir: string
  path: string
  start_line: number
  end_line: number
  author: string
  expected_content_hash: string
}): Promise<number> {
  const result = await requestJson<{ ok: boolean; claimed_lines: number }>(
    '/api/provenance/claim-human',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  )
  return result.claimed_lines
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '请求失败'
}
