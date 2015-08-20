function renderStatus(statusText) {
  document.getElementById('status').textContent = statusText;
}

function requestComplete() {
  renderStatus('');
  var resp = JSON.parse(this.response);
  $('#queryResult').bootstrapTable({
    'method': 'load', 
    'data': resp['rows'],
    'columns': [
      {
        'field': 'keys',
        'title': 'query',
        'sortable': true
      },
      {
        'field': 'clicks',
        'title': 'clicks',
        'sortable': true
      },
            {
        'field': 'impressions',
        'title': 'impressions',
        'sortable': true
      },
      {
        'field': 'ctr',
        'title': 'ctr',
        'sortable': true
      },
      {
        'field': 'position',
        'title': 'position',
        'sortable': true
      }
    ]
  });
}

function extractProperty(url) {
  var parser = document.createElement('a');
  parser.href = url;
  return encodeURIComponent(parser.protocol+'//'+parser.hostname+'/');
}

function handleAuthResult(access_token, url) {
  var property = extractProperty(url);
  var endDate = moment().format("YYYY-MM-DD");
  var startDate = moment().subtract(7, 'days').format("YYYY-MM-DD");
  var payload = {
    'startDate': '2015-08-01',
    'endDate': '2015-08-07',
    'dimensions': ['query'],
    'dimensionFilterGroups': [{
      'filters': [{
          'dimension': 'page',
          'operator': 'equals',
          'expression': url
        }]
    }],
    'rowLimit': 100
  };
  var xhr = new XMLHttpRequest();
  xhr.open('POST', 'https://content.googleapis.com/webmasters/v3/sites/'+property+'/searchAnalytics/query?alt=json', true);
  xhr.setRequestHeader('Authorization', 'Bearer ' + access_token);
  xhr.setRequestHeader('Content-type', 'application/json')
  xhr.onload = requestComplete;
  xhr.onerror = function() {
    renderStatus('Network error.');
  };
  xhr.send(JSON.stringify(payload));
  renderStatus('loading...');
}

chrome.runtime.onMessage.addListener(
  function(request, sender, sendResponse) {
    chrome.identity.getAuthToken({ 'interactive': true }, function(token) {
      handleAuthResult(token, request.url);
    });  
  }
);

document.addEventListener('DOMContentLoaded', function() {

});