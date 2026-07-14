/**
 * 개인택시 양수 자격진단 - 솔라피(Solapi) MMS 발송용 Apps Script
 * ---------------------------------------------------------------
 * 흐름: 웹페이지(브라우저) → 이 Apps Script 웹앱(doPost) → 솔라피 API → 신청자 휴대폰(MMS)
 *
 * [사전 준비 - 1회만]
 * 1) Apps Script 편집기 > 프로젝트 설정(톱니바퀴) > "스크립트 속성"에 아래 4개 등록
 *      SOLAPI_API_KEY    : 솔라피 API Key
 *      SOLAPI_API_SECRET : 솔라피 API Secret
 *      SOLAPI_SENDER     : 발신번호 (솔라피에 "등록"된 번호, 예: 15667114)
 *      SHEET_ID          : 데이터를 저장할 구글 시트 문서 ID
 * 2) 배포 > 새 배포 > 유형: 웹 앱 > 액세스 권한: "모든 사용자" 로 배포하고
 *      웹앱 URL을 HTML의 GAS_WEB_APP_URL 에 넣습니다.
 *
 * ※ 솔라피 MMS 이미지 규격: JPG · 200KB 이하 (웹페이지에서 190KB 이하로 압축해 보냄).
 * ※ 이미 시트 저장용 doPost가 있다면, doPost 전체를 덮어쓰지 말고
 *    sendSolapiMms(data) 호출 한 줄만 기존 저장 코드 뒤에 추가하면 됩니다.
 */

// ─────────────────────────────────────────────
// 진입점
// ─────────────────────────────────────────────
function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);

    // MMS 발송 (결과/오류를 시트에도 남긴다)
    var sendResult = '';
    if (data.phone && data.image) {
      try {
        sendResult = sendSolapiMms(data);
      } catch (sendErr) {
        sendResult = '발송오류: ' + sendErr;
      }
    } else if (!data.phone) {
      sendResult = '전화번호 없음 → 미발송';
    } else {
      sendResult = '이미지 없음 → 미발송';
    }
    // S열: 요약(성공 / 실패(원인)),  T열: 상세(원문 응답)
    data['_발송요약'] = summarizeSend(sendResult);
    data['_발송상세'] = sendResult;

    // 구글 시트 저장 (발송 결과 포함) → 저장된 행 번호
    var rowNum = saveToSheet(data);

    // 아직 결과가 확정되지 않았으면(발송 중) 대기열에 등록 → 트리거가 나중에 갱신
    var pend = parsePending(sendResult);
    if (pend.pending && pend.groupId) {
      registerPending(rowNum, pend.groupId, data);
      try { ensureSendStatusTrigger(); } catch (tErr) { Logger.log('트리거 설치 실패: ' + tErr); }
    }

    return jsonOut({ result: 'success', send: sendResult });
  } catch (err) {
    Logger.log('doPost 오류: ' + err);
    return jsonOut({ result: 'error', message: String(err) });
  }
}

// 솔라피 원문 실패 사유 → 직관적인 한국어로 치환 (매핑 없으면 원문 유지)
function friendlyReason(raw) {
  var s = String(raw || '').trim();
  if (!s) return '수신 실패';
  var map = [
    [/전송경로|경로.?없|no.?route|라우트/i, '없는 번호 / 결번'],
    [/착신번호|수신번호|번호\s?오류|잘못된\s?번호|invalid.?number|번호형식|형식\s?오류|format/i, '잘못된 번호 / 형식 오류'],
    [/수신거부|착신거절|수신\s?거부|거절|reject|blacklist/i, '수신 거부(수신자 차단)'],
    [/스팸|spam|수신\s?차단|차단/i, '스팸/수신 차단'],
    [/전원|power.?off|꺼짐|꺼져/i, '휴대폰 전원 꺼짐'],
    [/음영|서비스\s?지역|통화권|서비스\s?불가|out of|미개통|결번외/i, '서비스 불가/음영 지역'],
    [/잔액|충전|캐시|포인트|balance|부족/i, '잔액(캐시) 부족'],
    [/발신번호|미등록|미승인|sender|발신\s?번호/i, '발신번호 미등록/미승인'],
    [/시간\s?초과|timeout|만료|expire|지연/i, '전송 시간 초과'],
    [/용량|규격|사이즈|크기|size/i, '이미지 규격 초과'],
    [/단말|수신\s?실패|미수신/i, '단말 수신 실패']
  ];
  for (var i = 0; i < map.length; i++) { if (map[i][0].test(s)) return map[i][1]; }
  return s; // 매핑되는 항목이 없으면 원문 그대로 표시
}

// 발송 결과 원문 → '성공' 또는 '실패 (원인)' 요약으로 변환
function summarizeSend(raw) {
  raw = String(raw || '');
  if (raw.indexOf('발송오류') === 0) {
    return '실패 (' + friendlyReason(raw.replace('발송오류:', '').trim()) + ')';
  }
  if (raw.indexOf('미발송') !== -1) {
    return '미발송 (' + raw.split('→')[0].trim() + ')';
  }
  try {
    var j = JSON.parse(raw);
    // ── 신규 구조: 실제 전송 결과 조회값 {accept, result} ──
    if (j.result && j.result.state) {
      var st = j.result.state;
      if (st === 'success') return '성공';
      if (st === 'fail') return '실패 (' + friendlyReason(j.result.reason) + ')';
      if (st === 'pending') return '발송 중 (접수됨 · 1~2분 내 자동 갱신)';
      return '접수 완료 (결과 확인 필요)';
    }
    // ── 구 구조 하위호환 ──
    if (j.errorCode || j.errorMessage) {
      return '실패 (' + friendlyReason(j.errorMessage || j.errorCode) + ')';
    }
    if (j.failedMessageList && j.failedMessageList.length) {
      var f = j.failedMessageList[0];
      return '실패 (' + friendlyReason(f.statusMessage || f.statusCode) + ')';
    }
    var sc = j.statusCode || (j.groupInfo && j.groupInfo.status);
    if (sc && String(sc) !== '2000' && String(sc) !== '200') {
      return '실패 (' + friendlyReason(j.statusMessage || sc) + ')';
    }
    return '성공';
  } catch (e2) {
    return raw ? ('확인 필요 (' + raw.substring(0, 60) + ')') : '';
  }
}

// ─────────────────────────────────────────────
// 솔라피 MMS 발송 (이미지 업로드 → fileId → 발송)
// ─────────────────────────────────────────────
function sendSolapiMms(data) {
  var props = PropertiesService.getScriptProperties();
  var apiKey    = props.getProperty('SOLAPI_API_KEY');
  var apiSecret = props.getProperty('SOLAPI_API_SECRET');
  var sender    = props.getProperty('SOLAPI_SENDER');

  if (!apiKey || !apiSecret || !sender) {
    throw new Error('스크립트 속성(SOLAPI_API_KEY/SECRET/SENDER)이 설정되지 않았습니다.');
  }

  // 1) 이미지 업로드 → fileId 획득
  var fileId = solapiUploadImage(apiKey, apiSecret, data.image);

  var to = String(data.phone).replace(/-/g, '');
  var accepts = [];
  var groupIds = [];

  // 2) 1번 문자 발송 (진단표 이미지 포함 MMS)
  var msg1 = data.smsText ||
    '[개인택시 양수도센터]\n요청하신 개인택시 양수 자격 진단표를 보내드립니다.\n' +
    '자세한 상담은 1566-7114 로 문의해 주세요.';
  var r1 = solapiSendOne(apiKey, apiSecret, {
    to: to, from: sender, type: 'MMS',
    subject: '개인택시 양수 자격 진단표', text: msg1, imageId: fileId
  });
  accepts.push(r1.json);
  if (r1.acceptFail) {
    return JSON.stringify({ accept: accepts, result: { state: 'fail', reason: r1.reason }, groupIds: '' });
  }
  if (r1.groupId) groupIds.push(r1.groupId);

  // 3) 서류가 길어 두 통으로 분할된 경우 → 2번 문자(텍스트 LMS) 발송
  if (data.smsText2) {
    var r2 = solapiSendOne(apiKey, apiSecret, {
      to: to, from: sender, type: 'LMS',
      subject: '개인택시 양수 필요 서류 (이어서)', text: data.smsText2
    });
    accepts.push(r2.json);
    if (r2.groupId) groupIds.push(r2.groupId);
  }

  // 접수까지만 확인하고 즉시 반환 (신청자 응답 지연 방지)
  // 실제 단말 전송 성공/실패는 1분 주기 트리거(updatePendingSends)가 나중에 갱신
  var result = groupIds.length ? { state: 'pending' } : { state: 'unknown' };
  return JSON.stringify({ accept: accepts, result: result, groupIds: groupIds.join(',') });
}

// 단일 메시지 발송 → {json, groupId, acceptFail, reason}
function solapiSendOne(apiKey, apiSecret, message) {
  var res = UrlFetchApp.fetch('https://api.solapi.com/messages/v4/send', {
    method: 'post', contentType: 'application/json',
    headers: solapiAuthHeader(apiKey, apiSecret),
    payload: JSON.stringify({ message: message }),
    muteHttpExceptions: true
  });
  var text = res.getContentText();
  Logger.log('솔라피 발송 응답: ' + text);
  var json;
  try { json = JSON.parse(text); } catch (e) { return { json: text, acceptFail: true, reason: '응답 파싱 실패' }; }
  if (json.errorCode || json.errorMessage) {
    return { json: json, acceptFail: true, reason: json.errorMessage || json.errorCode };
  }
  var gid = json.groupId || (json.groupInfo && (json.groupInfo._id || json.groupInfo.groupId)) || null;
  return { json: json, groupId: gid, acceptFail: false };
}

// 발송 후 실제 전송 결과를 조회 (짧게 대기 — 빠른 실패/성공만 즉시 잡고, 나머지는 트리거가 갱신)
// groupIdsCsv: 콤마로 구분된 하나 이상의 groupId
function pollSolapiResult(apiKey, apiSecret, groupIdsCsv) {
  var waits = [1500, 2500];
  for (var i = 0; i < waits.length; i++) {
    Utilities.sleep(waits[i]);
    var r = pollGroupsOnce(apiKey, apiSecret, groupIdsCsv);
    if (r.state !== 'pending') return r;
  }
  return { state: 'pending' };
}

// 여러 그룹의 상태를 합산 조회. 하나라도 실패면 실패, 미확정 있으면 pending, 모두 성공이면 success
function pollGroupsOnce(apiKey, apiSecret, groupIdsCsv) {
  var ids = String(groupIdsCsv || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  if (!ids.length) return { state: 'pending' };
  var anyPending = false, failReason = '';
  for (var i = 0; i < ids.length; i++) {
    var r = pollGroupOnce(apiKey, apiSecret, ids[i]);
    if (r.state === 'fail') { if (!failReason) failReason = r.reason || '단말 수신 실패'; }
    else if (r.state === 'pending') { anyPending = true; }
  }
  if (failReason) return { state: 'fail', reason: failReason };
  if (anyPending) return { state: 'pending' };
  return { state: 'success' };
}

// 그룹 상태 1회 조회 → {state:'success'|'fail'|'pending', reason?}
// 그룹 집계(count)가 명확할 때만 확정 판정. 애매하면 pending 유지(트리거가 재시도)
function pollGroupOnce(apiKey, apiSecret, groupId) {
  try {
    var res = UrlFetchApp.fetch('https://api.solapi.com/messages/v4/groups/' + groupId, {
      method: 'get',
      headers: solapiAuthHeader(apiKey, apiSecret),
      muteHttpExceptions: true
    });
    var g = JSON.parse(res.getContentText());
    var c = g.count || (g.groupInfo && g.groupInfo.count) || {};
    var status = String(g.status || (g.groupInfo && g.groupInfo.status) || '').toUpperCase();
    var sentSuccess      = Number(c.sentSuccess || 0);
    var sentFailed       = Number(c.sentFailed || 0);
    var registeredFailed = Number(c.registeredFailed || 0);
    var sentPending      = Number(c.sentPending || 0);
    var sentTotal        = Number(c.sentTotal || 0);
    var registeredSuccess = Number(c.registeredSuccess || 0);
    if (sentSuccess > 0) return { state: 'success' };
    if (sentFailed > 0 || registeredFailed > 0) {
      return { state: 'fail', reason: getFailReason(apiKey, apiSecret, groupId) };
    }
    // 처리가 끝났는데(완료 상태 또는 대기 0인데 접수/발송 시도가 있었음) 성공 건이 0이면 → 실패로 판정
    var finished = (status.indexOf('COMPLETE') === 0) ||
                   (sentPending === 0 && (sentTotal > 0 || registeredSuccess > 0));
    if (finished) {
      return { state: 'fail', reason: getFailReason(apiKey, apiSecret, groupId) };
    }
  } catch (e) { /* 조회 실패 → 대기 유지 */ }
  return { state: 'pending' };
}

// 발송 결과가 '발송 중'인지와 groupId(들, CSV) 추출
function parsePending(raw) {
  try {
    var j = JSON.parse(raw);
    if (j.result && j.result.state === 'pending') {
      return { pending: true, groupId: j.groupIds || '' };
    }
  } catch (e) {}
  return { pending: false, groupId: null };
}

// ─────────────────────────────────────────────
// 발송 결과 지연 갱신 (대기열 + 1분 트리거)
// ─────────────────────────────────────────────
var PENDING_SHEET = '_발송대기';

// 대기열에 등록: [행번호, groupId, 시도횟수, 등록시각, 접수일시(검증), 연락처(검증)]
function registerPending(rowNum, groupId, data) {
  var props = PropertiesService.getScriptProperties();
  var sheetId = props.getProperty('SHEET_ID');
  var ss = sheetId ? SpreadsheetApp.openById(sheetId) : SpreadsheetApp.getActiveSpreadsheet();
  var p = ss.getSheetByName(PENDING_SHEET);
  if (!p) {
    p = ss.insertSheet(PENDING_SHEET);
    p.appendRow(['행번호', 'groupId', '시도횟수', '등록시각', '접수일시', '연락처']);
    p.hideSheet();
  }
  p.appendRow([rowNum, groupId, 0, new Date(), data.createdAt || '', data.phone || '']);
}

// 트리거로 1분마다 실행: 대기 건들의 실제 발송 결과를 조회해 메인 시트 S/T 열 갱신
function updatePendingSends() {
  var props = PropertiesService.getScriptProperties();
  var apiKey = props.getProperty('SOLAPI_API_KEY');
  var apiSecret = props.getProperty('SOLAPI_API_SECRET');
  var sheetId = props.getProperty('SHEET_ID');
  var ss = sheetId ? SpreadsheetApp.openById(sheetId) : SpreadsheetApp.getActiveSpreadsheet();
  var p = ss.getSheetByName(PENDING_SHEET);
  if (!p || p.getLastRow() < 2) return;
  var main = openMainSheet();
  var sCol = colOf('_발송요약'), tCol = colOf('_발송상세');
  var vals = p.getRange(2, 1, p.getLastRow() - 1, 6).getValues();
  var doneRows = [];
  for (var i = 0; i < vals.length; i++) {
    var rowNum = vals[i][0], groupId = vals[i][1], attempts = Number(vals[i][2] || 0);
    var r = pollGroupsOnce(apiKey, apiSecret, groupId);
    if (r.state === 'success' || r.state === 'fail') {
      writeSendResult(main, rowNum, sCol, tCol,
        r.state === 'success' ? '성공' : ('실패 (' + friendlyReason(r.reason) + ')'));
      doneRows.push(i + 2);
    } else {
      attempts++;
      if (attempts >= 30) { // 약 30분 경과까지 미확정이면 안내만 (배달 보고 지연 대비 창 확대)
        writeSendResult(main, rowNum, sCol, tCol, '발송 중 (장시간 미확정 · 솔라피 콘솔 확인)');
        doneRows.push(i + 2);
      } else {
        p.getRange(i + 2, 3).setValue(attempts);
      }
    }
  }
  doneRows.sort(function (a, b) { return b - a; }).forEach(function (rn) { p.deleteRow(rn); });
}

// 메인 시트 해당 행의 S/T 열 갱신.
// 안전장치: 해당 행 S열이 아직 '발송 중'일 때만 갱신(행이 밀렸거나 이미 확정된 경우 건드리지 않음)
function writeSendResult(main, rowNum, sCol, tCol, summary) {
  if (rowNum < 2 || rowNum > main.getLastRow()) return;
  var cur = String(main.getRange(rowNum, sCol).getValue());
  if (cur.indexOf('발송 중') === -1) return;
  main.getRange(rowNum, sCol).setValue(summary);
  var detail = main.getRange(rowNum, tCol).getValue();
  main.getRange(rowNum, tCol).setValue(String(detail) + '  →  [최종확인: ' + summary + ']');
}

// ── 최초 1회 실행: 1분 주기 트리거 설치 ──
function installSendStatusTrigger() {
  var existing = ScriptApp.getProjectTriggers();
  for (var i = 0; i < existing.length; i++) {
    if (existing[i].getHandlerFunction() === 'updatePendingSends') ScriptApp.deleteTrigger(existing[i]);
  }
  ScriptApp.newTrigger('updatePendingSends').timeBased().everyMinutes(1).create();
  Logger.log('발송 결과 갱신 트리거가 설치되었습니다 (1분 주기).');
}

// 트리거가 없으면 자동 설치 (첫 발송 시 doPost가 호출) → 수동 설치 불필요
function ensureSendStatusTrigger() {
  var existing = ScriptApp.getProjectTriggers();
  for (var i = 0; i < existing.length; i++) {
    if (existing[i].getHandlerFunction() === 'updatePendingSends') return;
  }
  ScriptApp.newTrigger('updatePendingSends').timeBased().everyMinutes(1).create();
  Logger.log('발송 결과 갱신 트리거를 자동 설치했습니다.');
}

// [진단용2] 특정 groupId의 솔라피 원본 상태를 로그로 출력.
// 실패로 남은 행의 T열(문자 발송 결과 상세)에서 "groupIds":"G..." 값을 복사해 아래에 붙여넣고 실행하세요.
function debugGroupById() {
  var GROUP_ID = '여기에_groupId_붙여넣기'; // ← T열에서 복사한 groupId (여러 개면 하나만)
  var props = PropertiesService.getScriptProperties();
  var apiKey = props.getProperty('SOLAPI_API_KEY'), apiSecret = props.getProperty('SOLAPI_API_SECRET');
  var gr = UrlFetchApp.fetch('https://api.solapi.com/messages/v4/groups/' + GROUP_ID, { method: 'get', headers: solapiAuthHeader(apiKey, apiSecret), muteHttpExceptions: true });
  Logger.log('[GROUP ' + GROUP_ID + '] ' + gr.getContentText());
  var lr = UrlFetchApp.fetch('https://api.solapi.com/messages/v4/list?groupId=' + GROUP_ID, { method: 'get', headers: solapiAuthHeader(apiKey, apiSecret), muteHttpExceptions: true });
  Logger.log('[LIST ' + GROUP_ID + '] ' + lr.getContentText());
  Logger.log('※ 위 두 줄을 복사해 전달해 주세요.');
}

// [진단용] 대기 중인 발송 건의 솔라피 원본 상태를 로그로 출력.
// 실제 문자 신청을 한 직후(발송 중 상태일 때) 편집기에서 이 함수를 실행하세요.
function debugSendStatus() {
  var props = PropertiesService.getScriptProperties();
  var apiKey = props.getProperty('SOLAPI_API_KEY'), apiSecret = props.getProperty('SOLAPI_API_SECRET');
  var sheetId = props.getProperty('SHEET_ID');
  var ss = sheetId ? SpreadsheetApp.openById(sheetId) : SpreadsheetApp.getActiveSpreadsheet();
  var p = ss.getSheetByName(PENDING_SHEET);
  if (!p || p.getLastRow() < 2) {
    Logger.log('대기 중인 발송 건이 없습니다. 실제로 문자 신청을 한 직후 곧바로 실행하세요.');
    Logger.log('트리거 설치 여부: ' + (ScriptApp.getProjectTriggers().some(function(t){return t.getHandlerFunction()==='updatePendingSends';}) ? '설치됨' : '미설치'));
    return;
  }
  var vals = p.getRange(2, 1, p.getLastRow() - 1, 2).getValues();
  for (var i = 0; i < vals.length; i++) {
    var ids = String(vals[i][1]).split(',');
    for (var k = 0; k < ids.length; k++) {
      var gid = ids[k].trim(); if (!gid) continue;
      var gr = UrlFetchApp.fetch('https://api.solapi.com/messages/v4/groups/' + gid, { method: 'get', headers: solapiAuthHeader(apiKey, apiSecret), muteHttpExceptions: true });
      Logger.log('[GROUP ' + gid + '] ' + gr.getContentText());
      var lr = UrlFetchApp.fetch('https://api.solapi.com/messages/v4/list?groupId=' + gid, { method: 'get', headers: solapiAuthHeader(apiKey, apiSecret), muteHttpExceptions: true });
      Logger.log('[LIST ' + gid + '] ' + lr.getContentText());
    }
  }
  Logger.log('※ 위 [GROUP]/[LIST] 응답을 복사해 전달하면 결과 판정 로직을 정확히 맞출 수 있습니다.');
}

// 실패 사유(메시지) 조회
function getFailReason(apiKey, apiSecret, groupId) {
  try {
    var res = UrlFetchApp.fetch('https://api.solapi.com/messages/v4/list?groupId=' + groupId, {
      method: 'get',
      headers: solapiAuthHeader(apiKey, apiSecret),
      muteHttpExceptions: true
    });
    var j = JSON.parse(res.getContentText());
    var list = j.messageList || {};
    var keys = Object.keys(list);
    if (keys.length) {
      var m = list[keys[0]];
      return m.statusMessage || m.reason || m.statusCode || '단말 수신 실패';
    }
  } catch (e) {}
  return '단말 수신 실패';
}

// 이미지 업로드 (MMS 용). 성공 시 fileId 반환
function solapiUploadImage(apiKey, apiSecret, base64) {
  var body = { file: base64, type: 'MMS' };

  var res = UrlFetchApp.fetch('https://api.solapi.com/storage/v1/files', {
    method: 'post',
    contentType: 'application/json',
    headers: solapiAuthHeader(apiKey, apiSecret),
    payload: JSON.stringify(body),
    muteHttpExceptions: true
  });

  var json = JSON.parse(res.getContentText());
  if (!json.fileId) {
    throw new Error('이미지 업로드 실패: ' + res.getContentText());
  }
  return json.fileId;
}

// 솔라피 HMAC-SHA256 인증 헤더 생성
function solapiAuthHeader(apiKey, apiSecret) {
  var date = new Date().toISOString();
  var salt = Utilities.getUuid().replace(/-/g, '');
  var sigBytes = Utilities.computeHmacSha256Signature(date + salt, apiSecret);
  var signature = sigBytes.map(function (b) {
    var v = (b < 0 ? b + 256 : b).toString(16);
    return v.length === 1 ? '0' + v : v;
  }).join('');

  return {
    'Authorization': 'HMAC-SHA256 apiKey=' + apiKey +
                     ', date=' + date +
                     ', salt=' + salt +
                     ', signature=' + signature
  };
}

// ─────────────────────────────────────────────
// 구글 시트 저장 (고정 컬럼 스키마 기준)
//  · [표시할 열 이름, payload 키] 순서대로 A열부터 한 번만 채웁니다.
//  · A~O = 운영자 지정 열, P 이후 = 부가 정보 열(발송결과 등)
//  · 열 이름을 바꾸고 싶으면 아래 배열의 왼쪽 값만 수정하세요.
//  · 마지막 열 이후에 수동으로 만든 메모/상태 열은 건드리지 않습니다.
// ─────────────────────────────────────────────
var DB_COLUMNS = [
  // ── A~O: 운영자 지정 열 ──
  ['접수일시',                    'createdAt'],                 // A
  ['이름',                        'name'],                      // B
  ['연락처',                      'phone'],                     // C
  ['유입경로',                    'source'],                    // D
  ['운행 희망 지역 1단계',        '운행 희망 지역 1단계'],      // E
  ['운행 희망 지역 2단계',        '운행 희망 지역 2단계'],      // F
  ['서울시 거주 이력',            '서울시 거주 이력'],          // G
  ['현재 서울 거주 여부',         '현재 서울 거주 여부'],       // H
  ['서울시 택시자격증 취득 여부', '서울시 택시자격증 취득 여부'],// I
  ['운전적성정밀검사 여부',       '운전적성정밀검사 여부'],     // J
  ['영업용 차량 경력 종류',       '영업용 차량 경력 종류'],     // K
  ['무사고 및 영업용 경력 여부',  '무사고 및 영업용 경력 여부'],// L
  ['영업용 경력자 상세 기간',     '영업용 경력자 상세 기간'],   // M
  ['양수교육 수료 여부',          '양수교육 수료 여부'],        // N
  ['신규교육 수료 여부',          '신규교육 수료 여부'],        // O
  // ── P 이후: 부가 정보 열 ──
  ['상담유형',                    'consultType'],               // P (양수계약가능/자격부족안내)
  ['개인정보 동의',               'privacyAgreed'],             // Q
  ['마케팅 동의',                 'marketingAgreed'],           // R
  ['문자 발송 결과',              '_발송요약'],                 // S (성공 / 실패(원인))
  ['문자 발송 결과(상세)',        '_발송상세']                  // T (원문 응답)
];

function saveToSheet(data) {
  var props = PropertiesService.getScriptProperties();
  var sheetId = props.getProperty('SHEET_ID');
  var ss = sheetId ? SpreadsheetApp.openById(sheetId) : SpreadsheetApp.getActiveSpreadsheet();

  // 저장 탭 이름: 스크립트 속성 SHEET_NAME 이 있으면 그 값을,
  // 없으면 '자격진단 응답DB' 를 사용. 탭 순서를 바꿔도 항상 이 이름의 탭에 저장됩니다.
  var sheetName = props.getProperty('SHEET_NAME') || '자격진단 응답DB';
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) sheet = ss.insertSheet(sheetName);

  var headers = DB_COLUMNS.map(function (c) { return c[0]; });

  // 1행 헤더가 스키마와 다르면(또는 비어 있으면) 헤더를 스키마대로 다시 기록
  var lastCol = sheet.getLastColumn();
  var cur = lastCol > 0 ? sheet.getRange(1, 1, 1, headers.length).getValues()[0] : [];
  if (cur.join('') !== headers.join('')) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }

  // 스키마 순서대로 값 매핑 (불리언은 Y/N 로 표시)
  var row = DB_COLUMNS.map(function (c) {
    var v = data[c[1]];
    if (v === true) return 'Y';
    if (v === false) return 'N';
    return (v === undefined || v === null) ? '' : v;
  });
  sheet.appendRow(row);
  return sheet.getLastRow(); // 방금 저장한 행 번호
}

// DB_COLUMNS 에서 특정 payload 키의 1-based 열 번호를 찾음
function colOf(key) {
  for (var i = 0; i < DB_COLUMNS.length; i++) {
    if (DB_COLUMNS[i][1] === key) return i + 1;
  }
  return 0;
}

// 스프레드시트(메인 탭) 열기
function openMainSheet() {
  var props = PropertiesService.getScriptProperties();
  var sheetId = props.getProperty('SHEET_ID');
  var ss = sheetId ? SpreadsheetApp.openById(sheetId) : SpreadsheetApp.getActiveSpreadsheet();
  var name = props.getProperty('SHEET_NAME') || '자격진단 응답DB';
  return ss.getSheetByName(name) || ss.insertSheet(name);
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
// 텍스트 발송 테스트 (SMS)
// ─────────────────────────────────────────────
function testSolapiText() {
  var props = PropertiesService.getScriptProperties();
  var apiKey = props.getProperty('SOLAPI_API_KEY');
  var apiSecret = props.getProperty('SOLAPI_API_SECRET');
  var body = {
    message: {
      to: '01000000000', // ← 본인 휴대폰번호로 변경
      from: props.getProperty('SOLAPI_SENDER'),
      text: '[테스트] 개인택시 양수도센터 문자발송 연동 테스트입니다.'
    }
  };
  var res = UrlFetchApp.fetch('https://api.solapi.com/messages/v4/send', {
    method: 'post', contentType: 'application/json',
    headers: solapiAuthHeader(apiKey, apiSecret),
    payload: JSON.stringify(body), muteHttpExceptions: true
  });
  Logger.log(res.getContentText());
}
