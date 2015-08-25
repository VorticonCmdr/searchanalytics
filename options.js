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

function updateSites() {
  var arr = [
    'siteOwner',
    'siteRestrictedUser',
    'siteFullUser'
  ];
  var resp = JSON.parse(this.response);
  var sites = [];
  $.each(resp['siteEntry'], function() {
  	if (jQuery.inArray(this.permissionLevel, arr ) > -1) {
  	  sites.push(this.siteUrl);
  	}
  });
  console.log(sites);
}

function getSites() {
	chrome.identity.getAuthToken({ 'interactive': true }, function(token) {
	  if (token !== undefined) {
	    var xhr = new XMLHttpRequest();
	    xhr.open('GET', 'https://www.googleapis.com/webmasters/v3/sites', true);
	    xhr.setRequestHeader('Authorization', 'Bearer ' + token);
	    xhr.onload = updateSites;
	    xhr.onerror = function() {
	      console.log('Network error.');
	    };
	    xhr.send();
	  } else {
		chrome.identity.getAuthToken({ 'interactive': false }, function(token) {
		  if (token !== undefined) {
		    var xhr = new XMLHttpRequest();
		    xhr.open('GET', 'https://www.googleapis.com/webmasters/v3/sites', true);
		    xhr.setRequestHeader('Authorization', 'Bearer ' + token);
		    xhr.onload = updateSites;
		    xhr.onerror = function() {
		      console.log('Network error.');
		    };
		    xhr.send();
		  } else {
		    console.log('authentication failed - please try again');
		  }
		});
	  }
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
	$( "#auth" ).on( "click", function() {
      getSites();
	});
  });
});