import { describe, expect, test } from 'bun:test';
import { runDiagnostics, formatReport } from '../doctor';

describe('doctor diagnostics', () => {
  test('runDiagnostics returns a valid report', async () => {
    const report = await runDiagnostics();
    expect(report.checks.length).toBeGreaterThan(0);
    expect(report.summary.pass + report.summary.warn + report.summary.fail).toBe(report.checks.length);
    expect(report.platform).toBeDefined();
  });

  test('bun check passes', async () => {
    const report = await runDiagnostics();
    const bunCheck = report.checks.find(c => c.name === 'Bun runtime');
    expect(bunCheck?.status).toBe('pass');
  });

  test('git check passes', async () => {
    const report = await runDiagnostics();
    const gitCheck = report.checks.find(c => c.name === 'Git');
    expect(gitCheck?.status).toBe('pass');
  });

  test('formatReport produces readable output', async () => {
    const report = await runDiagnostics();
    const formatted = formatReport(report);
    expect(formatted).toContain('open-agent doctor');
    expect(formatted).toContain('[OK]');
    expect(formatted).toContain('Summary');
  });

  test('all checks have timing', async () => {
    const report = await runDiagnostics();
    for (const check of report.checks) {
      expect(check.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  test('report has platform info', async () => {
    const report = await runDiagnostics();
    expect(report.platform).toContain(process.platform);
    expect(report.bunVersion).toBeDefined();
  });
});
