/**
 * 개인택시 양수 자격진단 - 알리고(Aligo) MMS 발송용 Apps Script
 * ---------------------------------------------------------------
 * 흐름: 웹페이지(브라우저) → 이 Apps Script 웹앱(doPost) → 알리고 API → 신청자 휴대폰(MMS)
 *
 * [사전 준비 - 1회만]
 * 1) Apps Script 편집기 > 프로젝트 설정(톱니바퀴) > "스크립트 속성"에 아래 4개 등록
 *      ALIGO_API_KEY   : 알리고 API 키
 *      ALIGO_USER_ID   : 알리고 로그인 아이디
 *      ALIGO_SENDER    : 발신번호 (알리고에 "사전등록"된 번호, 예: 15667114)
 *      SHEET_ID        : 데이터를 저장할 구글 시트 문서 ID
 *                        (시트 URL의 /d/ 와 /edit 사이 문자열)
 * 2) 알리고 관리자페이지 > "발송 IP 관리"에서 허용 IP를 "비워둠"(전체 허용).
 *      → 구글 서버 IP가 매번 바뀌므로 IP 제한을 켜두면 발송이 실패합니다.
 * 3) 배포 > 새 배포 > 유형: 웹 앱 > 액세스 권한: "모든 사용자" 로 배포하고
 *      웹앱 URL을 HTML의 GAS_WEB_APP_URL 에 넣습니다. (기존 URL 그대로여도 됨)
 *
 * ※ 이미 시트 저장용 doPost가 있다면, 아래 doPost 전체를 덮어쓰지 말고
 *    sendAligoMms(data) 호출 한 줄만 기존 저장 코드 뒤에 추가하면 됩니다.
 */

// ─────────────────────────────────────────────
// 진입점: 웹페이지에서 POST가 도착하면 실행
// ─────────────────────────────────────────────
function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);

    // 1) 구글 시트에 신청정보 저장
    saveToSheet(data);

    // 2) 이미지 + 연락처가 있으면 MMS 발송
    var sendResult = null;
    if (data.phone && data.image) {
      sendResult = sendAligoMms(data);
    }

    return jsonOut({ result: 'success', send: sendResult });
  } catch (err) {
    // 발송 실패해도 시트 저장은 유지되도록 로그만 남김
    Logger.log('doPost 오류: ' + err);
    return jsonOut({ result: 'error', message: String(err) });
  }
}

// ─────────────────────────────────────────────
// 알리고 MMS 발송
// ─────────────────────────────────────────────
function sendAligoMms(data) {
  var props = PropertiesService.getScriptProperties();
  var key    = props.getProperty('ALIGO_API_KEY');
  var userId = props.getProperty('ALIGO_USER_ID');
  var sender = props.getProperty('ALIGO_SENDER');

  if (!key || !userId || !sender) {
    throw new Error('스크립트 속성(ALIGO_API_KEY/USER_ID/SENDER)이 설정되지 않았습니다.');
  }

  // base64 → 이미지 Blob 복원
  var imgBytes = Utilities.base64Decode(data.image);
  var imgBlob  = Utilities.newBlob(imgBytes, 'image/jpeg', data.imageName || '진단표.jpg');

  var message = data.smsText ||
    '[개인택시 양수도센터]\n요청하신 개인택시 양수 자격 진단표를 보내드립니다.\n' +
    '자세한 상담은 1566-7114 로 문의해 주세요.';

  // UrlFetchApp은 payload에 Blob이 있으면 자동으로 multipart/form-data 로 전송
  var payload = {
    key: key,
    user_id: userId,
    sender: sender,
    receiver: data.phone,     // 수신번호 (하이픈 없이 숫자만 권장)
    msg: message,
    title: '개인택시 양수 자격 진단표',
    msg_type: 'MMS',
    image: imgBlob,
    testmode_yn: 'N'          // 테스트만 할 때는 'Y' (실제 발송·과금 없음)
  };

  var res = UrlFetchApp.fetch('https://apis.aligo.in/send/', {
    method: 'post',
    payload: payload,
    muteHttpExceptions: true
  });

  var text = res.getContentText();
  Logger.log('알리고 응답: ' + text);
  // 알리고 성공 시 result_code === 1
  return text;
}

// ─────────────────────────────────────────────
// 구글 시트 저장 (헤더 행 기준 자동 매핑)
//   - 시트 1행에 payload의 키(예: name, phone, 신규교육 수료 여부 …)와
//     같은 이름의 컬럼 헤더가 있으면 자동으로 채웁니다.
//   - 이미 저장 로직이 있다면 이 함수는 지우고 기존 것을 쓰세요.
// ─────────────────────────────────────────────
function saveToSheet(data) {
  var props = PropertiesService.getScriptProperties();
  var sheetId = props.getProperty('SHEET_ID');
  var ss = sheetId ? SpreadsheetApp.openById(sheetId) : SpreadsheetApp.getActiveSpreadsheet();

  // 저장 탭 이름: 스크립트 속성 SHEET_NAME 이 있으면 그 값을,
  // 없으면 '자격진단 응답DB' 를 사용. 탭 순서를 바꿔도 항상 이 이름의 탭에 저장됩니다.
  var sheetName = props.getProperty('SHEET_NAME') || '자격진단 응답DB';
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) sheet = ss.insertSheet(sheetName);

  var lastCol = sheet.getLastColumn();
  var headers = lastCol > 0
    ? sheet.getRange(1, 1, 1, lastCol).getValues()[0]
    : [];

  // 헤더가 없으면 payload 키로 헤더를 새로 만든다 (image 등 대용량 필드는 제외)
  if (headers.length === 0 || headers.join('') === '') {
    headers = Object.keys(data).filter(function (k) { return k !== 'image'; });
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }

  var row = headers.map(function (h) {
    if (h === 'image') return '(이미지 발송됨)';
    var v = data[h];
    return (v === undefined || v === null) ? '' : v;
  });
  sheet.appendRow(row);
}

// ─────────────────────────────────────────────
// 응답 헬퍼
// ─────────────────────────────────────────────
function jsonOut(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ─────────────────────────────────────────────
// 텍스트 발송 테스트 (편집기에서 직접 실행해 발신번호/키 점검)
//   - 이미지 없이 문자만 보내 계정·발신번호가 정상인지 확인
//   - TEST_받는번호 를 본인 번호로 바꾼 뒤 실행
// ─────────────────────────────────────────────
function testAligoText() {
  var props = PropertiesService.getScriptProperties();
  var payload = {
    key: props.getProperty('ALIGO_API_KEY'),
    user_id: props.getProperty('ALIGO_USER_ID'),
    sender: props.getProperty('ALIGO_SENDER'),
    receiver: '01000000000', // ← 본인 휴대폰번호로 변경
    msg: '[테스트] 개인택시 양수도센터 문자발송 연동 테스트입니다.',
    testmode_yn: 'N'
  };
  var res = UrlFetchApp.fetch('https://apis.aligo.in/send/', {
    method: 'post', payload: payload, muteHttpExceptions: true
  });
  Logger.log(res.getContentText());
}
