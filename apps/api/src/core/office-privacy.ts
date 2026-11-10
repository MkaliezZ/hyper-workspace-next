import type { Subject, OfficeSource } from "@hyper/contracts";
import type { PoolClient } from "pg";

/** Security cleanup is independent of current membership and execution lease. */
export async function redactOfficeRuns(
  c: Pick<PoolClient, "query">,
  s: Subject,
  scope: { binding: string } | { source: OfficeSource } | { allActor: true },
) {
  const source = "source" in scope ? scope.source : null;
  await c.query(
    `UPDATE cw_runs r SET instruction='',result=NULL,context_refs='[]'::jsonb,
       office_plan=jsonb_build_object('binding',office_plan->>'binding','redacted',true),
       state=CASE WHEN state IN ('queued','running') THEN 'failed' ELSE state END,
       error='Office 来源已失效，私人执行内容已清理。',updated_at=now()
     WHERE workspace_id=$1 AND actor_id=$2 AND office_plan IS NOT NULL AND
       ($3::boolean OR office_plan->>'binding'=$4 OR ($5::jsonb IS NOT NULL AND (
         office_plan->'plan'->'source'=$5::jsonb OR
         office_plan->>'binding' IN (
           SELECT source_binding FROM cw_office_proposals
           WHERE workspace_id=$1 AND actor_id=$2 AND source_file_id=$6 AND source_etag=$7
         ))))`,
    [
      s.workspaceId,
      s.id,
      "allActor" in scope,
      "binding" in scope ? scope.binding : null,
      source,
      source?.expectedId ?? null,
      source?.expectedEtag ?? null,
    ],
  );
}
