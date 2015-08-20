chrome.browserAction.onClicked.addListener(function (originTab) {

  //console.log(tab);
  chrome.tabs.create({'url': chrome.extension.getURL('popup.html')}, function (tab) {-
  	chrome.tabs.sendMessage(tab.id,originTab);
  });

});