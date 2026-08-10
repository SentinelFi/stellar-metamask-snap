# Automated security scans

Reports from **automated** static-analysis tools run against `packages/snap`.

These are **not** a third-party audit — they are tool output kept for reference and for the Snaps Directory submission (which asks for evidence that a security scan was run and its findings resolved). Formal third-party audit reports live one level up, in [../](../).

## Snapper

[Snapper](https://github.com/sayfer-io/Snapper) (by Sayfer) is the scanner named in MetaMask's allowlisting requirements. Run it via the `Snapper security scan` GitHub Actions workflow ([.github/workflows/snapper.yml](../../.github/workflows/snapper.yml)), which builds it from source (its npm release and Docker image are both broken). Routine runs stay as downloadable CI artifacts; the report from the **frozen pre-publish / audited commit** is what gets committed here. See [docs/research/snapper-security-scan.md](../../docs/research/snapper-security-scan.md) for the assessment and how-to.
