# Korea open-data viewer

A simple English web page that lets an overseas team browse Korean public data
(data.go.kr), centred on **deer-velvet (녹용) trade**. Pick a dataset from the
top menu, filter by period / item / country, read the table (drag to select and
copy, or screenshot), or flip it into a chart.

**Live site:** https://wkdjk.github.io/korea-opendata-viewer/

## How it works — no server, no exposed key

A scheduled GitHub Action fetches the data with the service key (stored as a
**GitHub Secret**), writes it to static JSON under `docs/data/`, and GitHub
Pages serves those files. The browser only ever reads same-origin JSON, so:

- the service key never appears in any page or committed file, and
- there is no cross-origin (CORS) call from the browser.

```
GitHub Action (Secret key) → fetch data.go.kr → docs/data/*.json → GitHub Pages → browser
```

## Datasets

1. **Customs — deer-velvet trade** — Korea Customs item/country import & export.
2. **Medicine — production & import** — MFDS medicine production/import figures.
3. **Herbal resource — inspection failures** — MFDS/NIFDS sensory-inspection
   non-conformity cases.

## Files

| Path | Purpose |
|------|---------|
| `scripts/ingest.py` | Fetches all datasets, writes `docs/data/*.json`. |
| `scripts/config.yaml` | What to fetch (HS codes, countries, years). **No key here.** |
| `.github/workflows/refresh.yml` | Weekly + manual run of the ingest. |
| `docs/` | The static viewer (`index.html`, `app.js`, `style.css`, Chart.js). |

## First-time setup (GitHub UI)

1. **Add the secret:** Settings → Secrets and variables → Actions → New
   repository secret. Name `DATA_GO_KR_KEY`, value = your data.go.kr service key.
2. **Enable Pages:** Settings → Pages → Source = *Deploy from a branch*,
   Branch = `main`, folder = `/docs`.
3. **Run once:** Actions → *Refresh data* → *Run workflow*. This fills
   `docs/data/` and the site goes live.

## Changing what is fetched

Edit `scripts/config.yaml` (add HS codes, countries, or years) and re-run the
workflow. No code change is needed.

## Notes on datasets 2 & 3

The portal blocks automated reading of the API spec, so the exact field names
and any required parameters for the two MFDS datasets are confirmed from the
first live workflow run (see the Action logs). The ingest reads every field the
API returns, so the datasets render even before English labels are added in
`config.yaml`. If a dataset shows an error note, set its `operation` /
`extra_params` in `config.yaml` from what the logs report.
