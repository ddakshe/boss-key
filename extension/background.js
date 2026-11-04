// 아이콘을 누르면 오른쪽 사이드패널이 열려요.
// (서비스 워커가 깨어날 때마다 다시 설정해서, 새로고침·재시작 뒤에도 항상 적용돼요.)
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

async function openPanel(tab) {
  // Chrome은 클릭·단축키 같은 사용자 동작이 있을 때만 패널을 열 수 있어요.
  try {
    if (tab?.windowId != null) await chrome.sidePanel.open({ windowId: tab.windowId });
    else if (tab?.id != null) await chrome.sidePanel.open({ tabId: tab.id });
  } catch (e) {
    // 사용자 동작 없이 불리면 Chrome이 거절해요. 그때는 아이콘을 눌러 열면 돼요.
  }
}

chrome.commands.onCommand.addListener(async (cmd, tabFromCmd) => {
  const tab = tabFromCmd || (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (!tab) return;
  if (cmd === 'open-panel') return openPanel(tab);
  if (cmd !== 'toggle-mailbox' || tab.id == null) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'mm-toggle' });
  } catch (e) {
    // chrome:// 페이지처럼 content.js가 못 들어가는 곳이에요.
  }
});

// 위장 화면의 ⚙ 버튼을 누르면 패널을 열어요.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === 'mm-open-panel' && sender.tab) openPanel(sender.tab);
});
