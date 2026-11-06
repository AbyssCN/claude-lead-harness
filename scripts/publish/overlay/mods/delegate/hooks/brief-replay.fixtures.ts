// Synthetic replay fixtures: three briefs that forgot the security section, plus one that references private client data.
const brief = (title: string, allowed: string) =>
  `# ${title}\n\n**原始目标原文(owner 01.10)**:「q」\n\n**允许改动:** ${allowed}\n\n对外签名:无\n期望值:无\n\n## 成功判据\n\`npx tsc --noEmit\` 绿。\n`

export const SENSITIVE_PATHS: string[] = ['supabase/migrations/*', 'supabase/functions/*', 'packages/payroll/*', 'apps/web/src/*/actions.ts']

export const REPLAY: { name: string; text: string }[] = [
  { name: 'docs/plan/10.11/px-aud-0360-consent.md', text: brief('0360 consent policy', 'supabase/migrations/0360_consent_events_select_setbased.sql') },
  { name: 'docs/plan/10.10/c4/S2-mapping.md', text: brief('payroll employee mapping', 'packages/payroll/src/api/employees.ts') },
  { name: 'docs/plan/10.12/oauth-gate-slice.md', text: brief('oauth gate', 'apps/web/src/lib/account/actions.ts') },
  {
    name: 'synthetic/client-a-oct-import.md',
    text: '# client-a-oct-import\n**原始目标原文(owner 14.10)**:「把 client-a 10 月的名册导进本地栈」\n**允许改动:** scripts/clients/client-a-oct-import.ts (新建)\n## 设计裁定(写死)\n对外签名:无\n期望值:无\n- 输入读 `~/repos/myapp/clients/client-a/2026-10/roster.json`,字段照 `clients/client-a/README.md`。\n## 成功判据\n`npx tsc --noEmit` 绿。\n',
  },
]
