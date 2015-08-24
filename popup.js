var settings = {
  searchanalyticsDays: 7,
  searchanalyticsRowLimit: 100
};

function renderStatus(statusText) {
  document.getElementById('status').textContent = statusText;
}

function requestComplete() {
  renderStatus('');
  var resp = JSON.parse(this.response);
  $('#queryResult').bootstrapTable({
    'method': 'load', 
    'data': resp['rows'],
    'exportDataType': 'all',
    'columns': [
      {
        'field': 'keys',
        'title': 'query',
        'sortable': true
      },
      {
        'field': 'clicks',
        'title': 'clicks',
        'sortable': true,
        'align': 'right'
      },
      {
        'field': 'impressions',
        'title': 'impressions',
        'sortable': true,
        'align': 'right'
      },
      {
        'field': 'ctr',
        'title': 'ctr',
        'sortable': true,
        'align': 'right',
        'formatter': function(value, row, index) {
          return (Math.round(value*10000)/100).toFixed(2);
        }
      },
      {
        'field': 'position',
        'title': 'position',
        'sortable': true,
        'align': 'right',
        'formatter': function(value, row, index) {
          return (Math.round(value*100)/100).toFixed(2);
        }
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
  $('#searchanalyticsUrl').val(url);
  $('#searchanalyticsProperty').val(decodeURIComponent(property));  
  var endDate = $('#datetimepickerEndDate').data().date || moment().format("YYYY-MM-DD");
  var startDate = $('#datetimepickerStartDate').data().date || moment().subtract(settings['searchanalyticsDays'], 'days').format("YYYY-MM-DD");
  var payload = {
    'startDate': startDate,
    'endDate': endDate,
    'dimensions': ['query'],
    'dimensionFilterGroups': [{
      'filters': [{
          'dimension': 'page',
          'operator': 'equals',
          'expression': url
        }]
    }],
    'rowLimit': settings['searchanalyticsRowLimit']
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
      if (token !== undefined) {
        handleAuthResult(token, request.url);
      } else {
        renderStatus('authentication failed - please try again');
      }      
    });

  }
);

$( document ).ready(function() {

  var keys = [
    'searchanalyticsDays',
    'searchanalyticsRowLimit'
  ];
  chrome.storage.sync.get(keys, function(items) {
    settings['searchanalyticsDays'] = items['searchanalyticsDays'] || 7;
    settings['searchanalyticsRowLimit'] = items['searchanalyticsRowLimit'] || 100;
    $('#searchanalyticsRowLimit').val(settings['searchanalyticsRowLimit']);

    var endDate = moment().format("YYYY-MM-DD");
    var startDate = moment().subtract(settings['searchanalyticsDays'], 'days').format("YYYY-MM-DD");
    $('#datetimepickerStartDate').datetimepicker({
      format: 'YYYY-MM-DD',
      defaultDate: startDate
    });
    $('#datetimepickerEndDate').datetimepicker({
      format: 'YYYY-MM-DD',
      defaultDate: endDate
    });
    $( "#searchanalyticsReload" ).on( "click", function() {
      chrome.identity.getAuthToken({ 'interactive': false }, function(token) {
        if (token !== undefined) {
          var customUrl = $('#searchanalyticsUrl').val();
          $('#queryResult').bootstrapTable('destroy');        
          handleAuthResult(token, customUrl);
        } else {
          renderStatus('authentication failed - please try again');
        }      
      });
    });
  });

});
