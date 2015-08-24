function message(msg) {
  $('#successMessage').text(msg);
  $('#success').show();
}

function saveChanges() {
  var days = $('#searchanalyticsDays').val();
  chrome.storage.sync.set({'searchanalyticsDays': days}, function() {
    message('Settings saved');
  });
}

$( document ).ready(function() {
  chrome.storage.sync.get('searchanalyticsDays', function(items) {
  	var days = items['searchanalyticsDays'] || 7;
  	$('#searchanalyticsDays').val(days);
  	
	$( "#save" ).on( "click", function() {
      saveChanges();
	});
  });
});