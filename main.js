#!/usr/bin/env node

var
    $ = require('jquery')
  , express = require('express')
  , fs = require('fs')
  , querystring = require('querystring')
  , request = require('request')
  , RSS = require('rss')
  , Twit = require('twit')
;

var CONFIG_FILE = process.cwd() + '/config.json';
var config = fs.existsSync(CONFIG_FILE)?
  JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) : {
    hostname: process.env.HOST,
    port: process.env.PORT,
    consumer_key: process.env.CONSUMER_KEY,
    consumer_secret: process.env.CONSUMER_SECRET,
    backup_frequency: 1000 * 60 * 1,
    fetch_frequency: 100 * 60 * 15,
    feed_item_max: 10000,
    since_id: {},
    items: []
  };
setInterval(function() {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config));
}, config.backup_frequency);

config.items = config.items.slice(0, config.feed_item_max);

var oauth_opt = {
  consumer_key: config.consumer_key,
  consumer_secret: config.consumer_secret
};

var is_on_heroku = /\/herokuapp.com/.test(config.hostname);

var feed_url = 'http://' + config.hostname + (is_on_heroku? '' : ':' + config.port) + '/';

function is_signed_in() {
  var check = [
    'oauth_token', 'oauth_token_secret',
    'user_id', 'screen_name'];

  $.each(check, function(k,v) {
    if(process.env[v]) { config[v] = process.env[v] || null; }
  });

  var result = true;
  $.each(check, function(k, v) {
    if(! config[v]) { result = false; }
  });
  return result;
}

function config_stream(stream) {
  stream.on('tweet', function(t) {
    // console.log('recieved tweet:', t);

    t.author = t.user.name + ' ( @' + t.user.screen_name + ' )'
    var html_text = t.text;
    t.entities.urls.forEach(function(v) {
      v.expanded_url = v.expanded_url || v.url;
      html_text = html_text.replace(
        v.url, $('<div />').append(
          $('<a />').attr('href', v.expanded_url).html(v.expanded_url)).html())
    });
    t.html_text = html_text;
    config.items.push(t);
  });
  stream.on('delete', function(t) {
    console.log('delete tweet:', t);
  });
  stream.on('limit', function(t) {
    console.log('limit:', t);
  });
  stream.on('scrub_geo', function(t) {
    console.log('scrub_geo:', t);
  });
}

var
    list_streams = [], lists = false, list_members = {}
  , timeline = false, followed_users = [], unfollowed_index = 0, searches = false
  , T = false
;

function is_already_followed(user_id) {
  var result = false;
  $.each(followed_users, function(k,v) {
    if(v.id_str === user_id) {
      result = true;
      return false;
    } else { return undefined; }
  });
  return result;
}

var
    FILTER_FOLLOW_MAX = 5000, API_MAX_PER_WINDOW = 350 /* 15 */
  , WINDOW_LENGTH = 1000 * 60 * 60 /* 1000 * 60 * 15 */, WAIT = 1000 * 5;

function create_list_stream(ids) {
  if(ids.length > FILTER_FOLLOW_MAX) {
    throw 'too many ids: ' + ids.length;
  }
  var ret = T.stream('statuses/filter', {follow: ids.join(','), stall_warnings: true});
  config_stream(ret);
  return ret;
}

function fetch_lists() {
  T.get('lists/all' /* 'lists/list' */, {user_id: config.user_id}, function(err, data) {
    if(err) {
      console.log(err);
      return;
    }
    lists = data;

    function fetch_list_members(id, c) {
      c = c || -1; // -1 is the first page
      T.get(
        'lists/members', {cursor: c, list_id: id,
                          include_entities: false, skip_status: true},
        function(err, mem) {
          if(err) {
            console.log(err);
            return;
          }

          list_members[id] = mem;

          mem.users.forEach(function(v) {
            if(!is_already_followed(v.id_str)) { followed_users.push(v); }
          });

          if((followed_users.length - unfollowed_index) > FILTER_FOLLOW_MAX) {
            list_streams.push(create_list_stream(
              followed_users.slice(unfollowed_index + FILTER_FOLLOW_MAX)
              .map(function(v) { return v.id_str; })
            ));
            unfollowed_index = unfollowed_index + FILTER_FOLLOW_MAX;
          }

          if(mem.next_cursor_str !== '0') {
            setTimeout(fetch_list_members, WAIT, id, mem.next_cursor_str);
          }
        });
    }

    lists.forEach(function(v, idx) {
      setTimeout(fetch_list_members,
                 Math.floor(idx / API_MAX_PER_WINDOW) * WINDOW_LENGTH +
                 (idx % API_MAX_PER_WINDOW) * WAIT,
                 v.id_str);
    });
  });
}

function create_timeline() {
  T.get('saved_searches' /* 'saved_searches/list' */, function(err, data) {
    if(err) {
      console.log(err);
      return;
    }

    timeline = T.stream(
      'user', {replies: 'all', stall_warnings: true,
               track: data.map(function(v) { return v.query; }).join(',')});
    config_stream(timeline);
  });
}

function signed_in(d) {
  console.log('Authorized!');

  ['oauth_token', 'oauth_token_secret', 'user_id', 'screen_name']
  .forEach(function(v) { config[v] = d[v]; });

  T = new Twit({
    consumer_key: config.consumer_key,
    consumer_secret: config.consumer_secret,
    access_token: config.oauth_token,
    access_token_secret: config.oauth_token_secret
  });

  fetch_lists();
  create_timeline();
}

var authorize_url = false;
function signin() {
  if(is_signed_in()) {
    oauth_opt.token = config.oauth_token;
    oauth_opt.token_secret = config.oauth_token_secret;
    signed_in(config);
  } else {
    oauth_opt.callback = feed_url + 'callback';
    request.post(
      {url:'https://api.twitter.com/oauth/request_token', oauth: oauth_opt},
      function (e, r, body) {
        if(e) { throw e; }

        var tok = querystring.parse(body);
        oauth_opt.token = tok.oauth_token;
        oauth_opt.token_secret = tok.oauth_token_secret;
        delete oauth_opt.callback;

        authorize_url = 'https://twitter.com/oauth/authorize?oauth_token=' + oauth_opt.token;
        console.log('Visit:', authorize_url);
        console.log('Or:', feed_url);
      });
  }
}

var twitter_api_left = false;

// run web server
var app = express();
app.use(express.compress({
  filter: function(req, res) {
    return (/json|text|javascript/.test(res.getHeader('Content-Type')))
        || (/application\/rss\+xml/.test(res.getHeader('Content-Type')));
  }
}));

app.get('/callback', function(req, res) {
  if(is_signed_in() && !authorize_url) {
    res.set('content-type', 'text/plain').send('Already signed in.');
    return;
  }

  oauth_opt.verifier = req.query.oauth_verifier;
  authorize_url = false;
  request.post(
    { url:'https://api.twitter.com/oauth/access_token', oauth: oauth_opt},
    function (e, r, result) {
      if(e) { throw e; }

      result = querystring.parse(result);
      oauth_opt.token = result.oauth_token;
      oauth_opt.token_secret = result.oauth_token_secret;
      delete oauth_opt.verifier;

      res.set('content-type', 'text/plain').send('Twitter OAuth Success!');

      console.log('Twitter OAuth result.');
      console.log(result);
      signed_in(result);
    });
});


app.get('/', function(req, res) {
  if(!is_signed_in() || authorize_url) {
    res.redirect(authorize_url);
    return;
  }

  console.log('config.items.length:', config.items.length);
  console.log('followed_users.length:', followed_users.length);

  var feed = new RSS(
    { title: config.title,
      'description': config.description,
      feed_url: feed_url,
      site_url: feed_url,
      author: config.author });

  config.items.slice(config.items.length > config.feed_item_max
                    ? config.items.length - config.feed_item_max : 0, config.feed_item_max)
  .forEach(function(v) {
    feed.item({
      title: v.text, description: v.html_text, url: v.url,
      author: v.author, date: v.created_at
    })
  });

  res.set('content-type', 'application/rss+xml');
  res.send(feed.xml());
});

app.listen(config.port);

signin();
