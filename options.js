function message(msg) {
  $('#successMessage').text(msg);
  $('#success').show();
}

function saveChanges() {
  var days = $('#searchanalyticsDays').val();
  var rowLimit = $('#searchanalyticsRowLimit').val();
  chrome.storage.sync.set({
  	'searchanalyticsDays': days,
  	'searchanalyticsRowLimit': rowLimit
  }, function() {
    message('Settings saved');
  });
}

var keys = [
  'searchanalyticsDays',
  'searchanalyticsRowLimit'
];
$( document ).ready(function() {
  chrome.storage.sync.get(keys, function(items) {
  	var days = items['searchanalyticsDays'] || 7;
  	var rowLimit = items['searchanalyticsRowLimit'] || 100;
  	$('#searchanalyticsDays').val(days);
    $('#searchanalyticsRowLimit').val(rowLimit);

	$( "#save" ).on( "click", function() {
      saveChanges();
	});
  });
});