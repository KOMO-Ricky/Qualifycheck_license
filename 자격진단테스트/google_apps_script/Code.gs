/**
 * 개인택시 양수 자격진단 - 신청 데이터 수집용 Google Apps Script
 * -------------------------------------------------------------
 * 이 스크립트는 진단 웹페이지(개인택시진단_병합.html)의 "문자 발송 신청" 폼에서
 * 전송하는 JSON 데이터를 받아 구글 스프레드시트에 한 줄씩 저장합니다.
 *
 * ★ 특징: payload에 새로운 항목이 생기면 헤더(1행)에 컬럼이 자동으로 추가됩니다.
 *    → 앞으로 폼 항목이 바뀌어도 이 스크립트 자체는 수정할 필요가 거의 없습니다.
 *    (코드 자체를 바꾸지 않는 한, 재배포도 불필요합니다.)
 *
 * 배포 방법은 같은 폴더의 "배포안내.md" 파일을 참고하세요.
 */

// 데이터를 기록할 시트(탭) 이름. 원하는 이름으로 바꿔도 됩니다.
// 이 이름의 탭이 없으면 자동으로 새로 만들어서 거기에 기록합니다.
var SHEET_NAME = '자격진단 응답DB';

// 배포가 실제로 갱신됐는지 확인하는 용도의 버전 표시. 재배포하면 아래 문구가 URL에 보입니다.
var VERSION = '2026-07-02c';

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000); // 동시 요청이 겹쳐도 데이터가 섞이지 않도록 잠금

  try {
    Logger.log('doPost 수신 (버전 ' + VERSION + ')');
    var data = JSON.parse(e.postData.contents);

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    // 지정한 이름의 탭이 없으면 자동으로 새로 만들어 사용 (엉뚱한 탭에 기록되는 문제 방지)
    var sheet = ss.getSheetByName(SHEET_NAME);
    if (!sheet) sheet = ss.insertSheet(SHEET_NAME);

    // 1) 현재 헤더(1행) 읽기
    var headers = [];
    if (sheet.getLastRow() > 0) {
      headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    }

    // 2) payload에 새 키가 있으면 헤더 끝에 자동 추가
    var changed = false;
    Object.keys(data).forEach(function (key) {
      if (headers.indexOf(key) === -1) {
        headers.push(key);
        changed = true;
      }
    });
    if (changed || sheet.getLastRow() === 0) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    }

    // 3) 헤더 순서에 맞춰 값 정렬 후 한 줄 추가
    var row = headers.map(function (key) {
      var v = data[key];
      if (v === true) return 'Y';         // 동의 여부 등 boolean → Y/N
      if (v === false) return 'N';
      if (v === undefined || v === null) return '';
      return v;
    });
    sheet.appendRow(row);

    // 실행 로그에 "어느 스프레드시트 / 어느 탭 / 몇 번째 행"에 기록했는지 남김 (진단용)
    Logger.log('기록 완료 → 스프레드시트: "' + ss.getName() + '" / 탭: "' + sheet.getName()
      + '" / 현재 총 행수: ' + sheet.getLastRow());

    return jsonOut({ result: 'success', version: VERSION, sheet: sheet.getName(), rows: sheet.getLastRow() });
  } catch (err) {
    return jsonOut({ result: 'error', message: String(err) });
  } finally {
    lock.releaseLock();
  }
}

// 배포 URL이 살아있는지 + 어떤 버전이 실제로 배포됐는지 확인하는 용도.
// 브라우저로 이 URL을 열었을 때 아래 "버전 ..." 문구가 최신인지 보면 재배포 성공 여부를 알 수 있습니다.
function doGet() {
  return ContentService.createTextOutput('OK - 개인택시 진단 수집기 정상 동작 중 (버전 ' + VERSION + ')');
}

function jsonOut(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
