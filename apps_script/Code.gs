/**
 * Google Apps Script backend for the Theaternacht survey.
 *
 * Deploy: Extensions ▸ Apps Script in a Google Sheet, paste this file, then
 * Deploy ▸ New deployment ▸ Web app (Execute as: me, Access: Anyone).
 * Copy the /exec URL into docs/config.js (APPS_SCRIPT_URL).
 *
 * The SHARED_PASSWORD below must match the one in docs/config.js. It is only a
 * light gate against random submissions, not real security.
 */

var SHARED_PASSWORD = "odyssee2026";
var SHEET_NAME = "Antworten";
var HEADERS = ["Empfangen", "Name", "Theater", "Programmpunkt", "Uhrzeiten", "ShowId", "Abgesendet"];

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (lockErr) {
    return jsonOutput({ ok: false, error: "Server ausgelastet, bitte erneut versuchen." });
  }

  try {
    if (!e || !e.postData || !e.postData.contents) {
      return jsonOutput({ ok: false, error: "Keine Daten empfangen." });
    }

    var data = JSON.parse(e.postData.contents);

    if (String(data.password) !== SHARED_PASSWORD) {
      return jsonOutput({ ok: false, error: "Falsches Passwort." });
    }

    var name = String(data.name || "").trim();
    var selections = data.selections || [];
    if (!name) {
      return jsonOutput({ ok: false, error: "Name fehlt." });
    }

    var sheet = getSheet();

    // Vorherige Auswahl dieses Namens entfernen (Update statt Anhängen).
    var removed = deleteRowsForName(sheet, name);

    // Leere Auswahl = Eintrag komplett löschen (nichts neu einfügen).
    if (!selections.length) {
      return jsonOutput({ ok: true, saved: 0, replaced: removed, deleted: true });
    }

    var receivedAt = new Date();
    var submittedAt = data.submittedAt || "";

    var rows = selections.map(function (sel) {
      return [
        receivedAt,
        name,
        String(sel.theater || ""),
        String(sel.show || ""),
        String(sel.times || ""),
        String(sel.showId || ""),
        submittedAt,
      ];
    });

    sheet
      .getRange(sheet.getLastRow() + 1, 1, rows.length, HEADERS.length)
      .setValues(rows);

    return jsonOutput({ ok: true, saved: rows.length, replaced: removed });
  } catch (err) {
    return jsonOutput({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

/**
 * Löscht alle Datenzeilen, deren Name (Spalte 2) dem angegebenen Namen
 * entspricht (Gross-/Kleinschreibung und Leerzeichen werden ignoriert).
 * Gibt die Anzahl der entfernten Zeilen zurück.
 */
function deleteRowsForName(sheet, name) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return 0; // Nur Kopfzeile vorhanden.
  }

  var target = name.trim().toLowerCase();
  var names = sheet.getRange(2, 2, lastRow - 1, 1).getValues();
  var removed = 0;

  // Von unten nach oben löschen, damit sich die Indizes nicht verschieben.
  for (var i = names.length - 1; i >= 0; i--) {
    if (String(names[i][0]).trim().toLowerCase() === target) {
      sheet.deleteRow(i + 2); // +2: Kopfzeile + 0-basiert.
      removed++;
    }
  }
  return removed;
}

function doGet() {
  return jsonOutput({ ok: true, service: "theaternacht-umfrage" });
}

function getSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
  }
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function jsonOutput(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON
  );
}
