# theaternacht-umfrage

Interaktive Umfrage-Karte für die **Lange Nacht der Theater in Hamburg**.
Die Leute öffnen einen Link, tragen ihren Namen ein, sehen alle Theater auf einer
Karte und setzen pro Programmpunkt ein Häkchen ("Worauf habt ihr Lust?"). Die
Antworten landen in einem Google Sheet, aus dem du eine Route für den Abend ableitest.

- **Karte + Umfrage:** statische Leaflet-Website (Ordner `docs/`), gehostet über GitHub Pages
- **Programmdaten:** Python-Pipeline zieht Titel, Beschreibung, Adresse, Koordinaten und
  Uhrzeiten aus der offiziellen Programm-Datenquelle → `docs/data/programm.json`
- **Antworten:** Google Apps Script schreibt jede Auswahl als Zeile in ein Google Sheet

```
docs/                     # die Website (GitHub Pages)
  index.html
  app.js
  config.js               # <-- HIER Passwort & Apps-Script-URL eintragen
  style.css
  data/programm.json      # von der Pipeline erzeugt
apps_script/Code.gs       # Backend für das Google Sheet
src/theaternacht_umfrage/ # Daten-Pipeline (Python)
```

## 1. Programmdaten erzeugen

Voraussetzung: [Poetry](https://python-poetry.org/) und Python ≥ 3.12.

```bash
poetry install
poetry run python -m theaternacht_umfrage
```

Das schreibt `docs/data/programm.json` (aktuell 33 Theater, 92 Programmpunkte).
Am Ende siehst du eine Warnung, falls ein Theater keine Koordinaten hat.

Die Beschreibungen kommen direkt aus der strukturierten Datenquelle – dafür wird
**kein OpenAI-Schlüssel benötigt**.

### Optional: kurze Teaser per KI

Falls du zu jedem Programmpunkt einen knackigen Ein-Satz-Teaser möchtest:

```bash
cp env.example .env      # OPENAI_API_KEY eintragen
poetry run python -m theaternacht_umfrage --enrich
```

Das nutzt `pydantic_ai` + OpenAI und ergänzt in jedem Programmpunkt ein Feld
`teaser`, das die Website dann statt der langen Beschreibung anzeigt.

## 2. Antworten-Backend (Google Sheet) einrichten

1. Ein neues **Google Sheet** anlegen.
2. **Erweiterungen ▸ Apps Script** öffnen, den Inhalt von
   [`apps_script/Code.gs`](apps_script/Code.gs) einfügen.
3. Oben in `Code.gs` `SHARED_PASSWORD` auf dein Wunsch-Passwort setzen.
4. **Bereitstellen ▸ Neue Bereitstellung ▸ Web-App**:
   - *Ausführen als:* Ich
   - *Zugriff:* Alle (auch anonym)
5. Die angezeigte **`…/exec`-URL** kopieren.

Jede abgesendete Auswahl erscheint als Zeile im Blatt „Antworten“
(Empfangen, Name, Theater, Programmpunkt, Uhrzeiten, ShowId, Abgesendet).

## 3. Website konfigurieren

In [`docs/config.js`](docs/config.js) eintragen:

```js
window.APP_CONFIG = {
  APPS_SCRIPT_URL: "https://script.google.com/macros/s/…/exec",
  SHARED_PASSWORD: "dein-passwort", // muss mit Code.gs übereinstimmen
};
```

Lokal testen:

```bash
cd docs && python3 -m http.server 8000
# Browser: http://localhost:8000
```

## 4. Über GitHub Pages veröffentlichen

GitHub Pages ist kostenlos nur für **öffentliche** Repos.

1. Repo auf **public** stellen (Settings ▸ General ▸ Change visibility).
2. Änderungen committen und pushen.
3. **Settings ▸ Pages ▸ Build and deployment:**
   - *Source:* Deploy from a branch
   - *Branch:* `main`, Ordner `/docs`
4. Nach ein paar Minuten ist die Seite unter
   `https://<user>.github.io/<repo>/` erreichbar.
5. Link + Passwort in die WhatsApp-Gruppe teilen.

> Hinweis: Das Passwort steht im öffentlichen `config.js` und ist nur ein leichter
> Zugangsriegel, kein echter Schutz. Für eine informelle Gruppe reicht das.

## 5. Auswerten

Im Google Sheet nach `Programmpunkt` oder `Theater` sortieren/filtern oder eine
Pivot-Tabelle bauen (Zeilen: Programmpunkt, Werte: Anzahl Name) und daraus die
Route für den Abend ableiten.

## Daten aktualisieren

Ändert sich das Programm, einfach erneut `poetry run python -m theaternacht_umfrage`
laufen lassen und den aktualisierten `docs/data/programm.json` pushen.
