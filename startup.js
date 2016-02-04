
"use strict";

var SerialPort = require ('serialport').SerialPort;
var debug = require ('debug')('wyliodin:app:server');
var pty = require ('pty.js');
var child_process = require ('child_process');
var _ = require ('lodash');
var fs = require ('fs');
var async = require ('async');
var runAnotherProject = null;
var redis = require ("redis");

var subscriber = redis.createClient ();
var client = redis.createClient ();

var PROJECT_PID_TEMP = '/tmp/.app-project';

debug ('Reading projectpid');
var projectpid = 0;
try
{
	projectpid = fs.readFileSync (PROJECT_PID_TEMP);
	debug ('projectpid '+projectpid);
}
catch (e)
{

}

debug ('Erasing signals');
client.ltrim ('app-project', 0, -1);

var sendingValues = false;
var storedValues = false;

var sendQueue = [];
var sendLowPriorityQueue = [];

var sending = false;

subscriber.on ('error', function (error)
{
	console.log ('subscriber redis '+error);
});

subscriber.subscribe ("wyliodrin-project", function (channel, count)
{
	debug ("Subscribed");
});

subscriber.on ("message", function (channel, message)
{
	if (message.indexOf ('signal:app-project')===0)
	{
		var projectId = message.substring(7);
		sendValues (projectId);
	}
});

client.on ('error', function (error)
{
	console.log ('client redis '+error);
});

var msgpack = require ('msgpack-lite');

var isConnected = false;

var EventEmitter = require ('events').EventEmitter;

debug ('Reading board type');
var boardtype = fs.readFileSync ('/etc/wyliodrin/boardtype');
debug ('Board type '+boardtype);
if (!boardtype)
{
	console.log ('Unknown board type');
	process.exit (-10);
}

debug ('Loading settings from /etc/wyliodrin/settings_'+boardtype+'.json');
var settings = require ('/etc/wyliodrin/settings_'+boardtype+'.json');

var config_file = require (settings.config_file);

var PACKET_SEPARATOR = config_file.serialpacketseparator || 255;
var PACKET_ESCAPE = config_file.serialpacketseparator || 0;
var BUFFER_PACKET_SEPARATOR = new Buffer([PACKET_SEPARATOR, PACKET_SEPARATOR]);
var BUFFER_SIZE = config_file.serialbuffersize || 4096;
var receivedFirstPacketSeparator = false;

var receivedData = new Buffer (BUFFER_SIZE);
var receivedDataPosition = 0;
var previousByte = 0;

var serial = new SerialPort ('/dev/ttyAMA0', {
		baudrate: config_file.serialbaudrate || 115200,
	}, false);

serial.open (function (error)
{
	if (!error)
	{
		debug ('Serial connected');
		isConnected = true;
		send ('', null);
		send ('ping', null);
		status ();
	}
	else
	{
		console.log (error);
		process.exit (-20);
	}	
});

function status ()
{
	debug ('Sending status');
	send ('i', {n:config_file.jid, c:boardtype.toString(), r:projectpid!==0});
}

serial.on ('error', function (error)
{
	debug ('Serial port error '+error);
	console.log (error);
	process.exit (-20);
});

var timer = 50;

serial.on ('data', function (data)
{
	// console.log (data.length);
	for (var pos = 0; pos < data.length; pos++)
	{
		// console.log (data[pos]);
		receivedDataSerial (data[pos]);
	}
});

var shell = null;
var project = null;

function addToBuffer (data)
{
	// TODO put maximum limit
	// debug ('Adding '+data+' to receivedData');
	if (receivedDataPosition >= receivedData.length)
	{
		// TODO verify a maximum size
		debug ('Data size exceeded, enlarging data with '+receivedData.length);
		var r = receivedData;
		receivedData = new Buffer (r.length*2);
		for (var pos=0; pos < r.length; pos++)
		{
			receivedData[pos] = r[pos];
		}
		receivedDataPosition = pos;
	}
	receivedData[receivedDataPosition] = data;
	receivedDataPosition=receivedDataPosition+1;
}

function packet ()
{
	debug ('Packet of size '+receivedDataPosition+' received');
	var data = receivedData.slice (0, receivedDataPosition);
	receivedDataPosition = 0;
	console.log (data.length)
	var m;
	try
	{
		m = msgpack.decode (data);
	}
	catch (e)
	{
		console.log ('Received a packet with errors');
	}
	return m;
}

function openShell (p)
{
	if (!shell)
	{
		shell = pty.spawn('bash', [], {
		  name: 'xterm-color',
		  cols: p.c,
		  rows: p.r,
		  cwd: '/wyliodrin',
		  env: _.assign (process.env, {HOME:'/wyliodrin'})
		});

		shell.on('data', function(data) {
		  	send ('s', {a:'k', t:data});
		});

		shell.on ('exit', function ()
		{
			send ('s', {a:'k', t:'Shell closed\n'});
			shell = null;
		})
	}
	shell.resize (p.c, p.r);
}


function keysShell (keys)
{
	if (shell) shell.write (keys);
}

function resizeShell (cols, rows)
{
	if (shell) shell.resize (cols, rows);
}

function stopProject ()
{
	if (projectpid !== 0)
	{
		child_process.exec (settings.stop+' '+projectpid);
		projectpid = 0;
		fs.unlink (PROJECT_PID_TEMP);
		if (project === null) status ();
	}
}

function runProject (p)
{
	var dir = settings.build_file+'/app_project';
	var exec = child_process.exec;
	var ext = 'js';
	if (p.l === 'python') ext = 'py';
	else
	if (p.l === 'visual') ext = 'py';
	if (projectpid !== 0)
	{
		runAnotherProject = p;
		debug ('Stop project already started '+projectpid);
		stopProject ();
	}
	else
	{
		runAnotherProject = null;
		debug ('Removing project');
		exec ('mkdir -p '+dir+' && sudo rm -rf '+dir+'/* && mkdir -p '+dir+'/Arduino/src', function (err, stdout, stderr)
		{
			debug ('err: '+err);
			debug ('stdout: '+stdout);
			debug ('stderr: '+stdout);
			if (stdout) send ('p', {a:'start', r:'s', s:'o', t:stdout});
			if (stderr) send ('p', {a:'start', r:'s', s:'e', t:stderr});
			if (err) send ('p', {a:'start', r:'e', e:err});
			if (!err) async.series ([
					function (done) { fs.writeFile (dir+'/main.'+ext, p.p, done); },
					function (done) { if (p.f) fs.writeFile (dir+'/Arduino/src/Arduino.ino', p.f, done); else setTimeout (done); },
					function (done) { fs.writeFile (dir+'/Makefile.'+boardtype, p.m, done); }
				],
				function (err, results)
				{
					if (err)
					{
						debug ('Error writing files '+dir+' error '+err);
					}
					else
					{
						var makerun = settings.run.split(' ');
						project = pty.spawn(makerun[0], makerun.slice (1), {
						  name: 'xterm-color',
						  cols: p.c,
						  rows: p.r,
						  cwd: dir,
						  env: _.assign (process.env, {HOME:'/wyliodrin', wyliodrin_project:"app-project"})
						});

						projectpid = project.pid;

						fs.writeFileSync (PROJECT_PID_TEMP, projectpid);

						if (project) send ('p', {a:'start', r:'d'});
						else send ('p', {a:'start', r:'e'});

						status ();

						project.on('data', function(data) {
							if (runAnotherProject === null)
							{
						  		sendLowPriority ('p', {a:'k', t:data});
						  	}
						});
						project.resize (p.c, p.r);
						}

						project.on ('exit', function (error)
						{
							project = null;
							if (runAnotherProject !== null) 
							{
								runProject (runAnotherProject);
							}
							else 
							{
								send ('p', {a:'k', t:'Project exit with error '+error+'\n'});
								send ('p', {a:'stop'});
								status ();
							}
						})
				});
			// fs.writeFile (dir+'/main.'+ext, p.p, function (err)
			// {
			// 	if (err)
			// 	{
			// 		debug ('Error writing file '+dir+'/app_project/main.'+ext);
			// 	}
			// 	else
			// 	{
			// 		project = pty.spawn('sudo', ['-E', 'node', 'main.js'], {
			// 		  name: 'xterm-color',
			// 		  cols: p.c,
			// 		  rows: p.r,
			// 		  cwd: dir+'/app_project',
			// 		  env: process.env
			// 		});

			// 		project.on('data', function(data) {
			// 		  	send ('r', {a:'k', t:data});
			// 		});
			// 		project.resize (p.c, p.r);
			// 	}
			// });
		});
	}
}

function resizeProject (cols, rows)
{
	if (project) project.resize (cols, rows);
}

function keysProject (keys)
{
	if (project) project.write (keys);
}

serial.on ('message', function (t, p)
{
	debug ('Receive message with tag '+t);
	// Shell
	if (t === 's')
	{
		// open
		if (p.a === 'o')
		{
			if (!shell)
			{
				openShell (p);
			}
		}
		else
		if (p.a === 'r')
		{
			resizeShell (p.c, p.r);
		}
		else
		if (p.a === 'k')
		{
			if (shell) keysShell (p.t);
			else send ('s', {a:'e', e:'noshell'});
		}
	}
	else
	// I
	if (t === 'i')
	{
		status ();
	}
	else
	// Run
	if (t === 'p')
	{
		if (p.a === 'start')
		{
			runProject (p);
		}
		else if (p.a === 'stop')
		{
			stopProject ();
		}
		else if (p.a === 'k')
		{
			keysProject (p.t);
		}
	}
	else
	// Ping
	if (t === 'ping')
	{
		send ('pong', null);
	}
});

function escape (data)
{
	var l = 0;
	for (var i=0; i<data.length; i++)
	{
		if (data[i]===PACKET_SEPARATOR) l = l+2;
		else l = l+1;
	}
	if (l===data.length) return data;
	else
	{
		var dataserial = new Buffer (l);
		var li=0;
		for (var i=0; i<data.length; i++)
		{
			if (data[i] === PACKET_SEPARATOR)
			{
				dataserial[li]=data[i];
				li++;
				dataserial[li]=PACKET_ESCAPE;
				li++;
			}
			else
			{
				dataserial[li] = data[i];
				li++;
			}
		}
		return dataserial;
	}
}

function receivedDataSerial (data)
{
	if (!receivedFirstPacketSeparator)
	{
		if (data === PACKET_SEPARATOR && previousByte === PACKET_SEPARATOR)
		{
			receivedFirstPacketSeparator = true;
			previousByte = 0;
		}
		else
		{
			debug ('Received random bytes');
			previousByte = data;
		}
	}
	else
	{
		// console.log (data);
		if (data === PACKET_SEPARATOR)
		{
			if (previousByte === PACKET_SEPARATOR)
			{
				var m = packet ();
				console.log (m);
				serial.emit ('message', m.t, m.d);
				previousByte = 0;
			}
			else
			{
				previousByte = data;
			}
		}
		else
		if (data === PACKET_ESCAPE)
		{
			if (previousByte === PACKET_SEPARATOR)
			{
				addToBuffer (previousByte);
				previousByte = 0;
			}
			else
			{
				addToBuffer (data);
				previousByte = data;
			}
		}
		else
		{
			if (previousByte === PACKET_SEPARATOR)
			{
				debug ('Random bytes for port '+this.port+' using connectionId '+this.connection.connectionId);
			}
			addToBuffer(data);
			previousByte = data;
		}
	}
	
}

function sendLowPriority (tag, data)
{
	sendLowPriorityQueue.push ({t: tag, d: data});
	_send ();
}

function send (tag, data)
{
	sendQueue.push ({t: tag, d: data});
	_send ();
}

function _send ()
{
	if (sending === false)
	{
		var message = null;
		if (sendQueue.length>0)
		{
			message = sendQueue[0];
			sendQueue.splice (0,1);
		}
		else if (sendLowPriorityQueue.length>0)
		{
			message = sendLowPriorityQueue[0];
			sendLowPriorityQueue.splice (0,1);
		}
		if (message)
		{
			debug ('Sening tag '+message.t+' data '+JSON.stringify (message.d));
			var m = escape(msgpack.encode (message));
			// console.log (msgpack.decode (new Buffer (m, 'base64')));
			// console.log (m.toString ());
			if (isConnected)
			{
				sending = true;
				serial.write (m, function (err, result)
				{
					if (!err)
					{
						debug ('Sent '+m.length+' bytes');
					}
					else 
					{
						debug ('Send error '+m);
						console.log (err);
					}
				});
				serial.write (BUFFER_PACKET_SEPARATOR, function (err, result)
				{
					sending = false;
					_send ();
					// console.log (err);
				});
			}
		}
	}
	else
	{
		debug ('Already sedning');
	}
}

function sendValues (projectId)
{
	if (!sendingValues)
	{
		sendingValues = true;
		debug ('Signal');
		client.lrange (projectId, 0, 100, function (err, signals)
		{
			if (err)
			{
				debug ('Signals error '+err);
			}
			else if (signals.length > 0)
			{
				storedValues = false;
				_.each (signals, function (signal)
				{
					var s = JSON.parse (signal);
					sendLowPriority ('v', {t:s.timestamp, s:s.signals});
				});
				client.ltrim (projectId, signals.length, -1, function (err)
				{
					if (err)
					{
						debug ('Signals error '+err);
					}
					sendingValues = false;
					if (storedValues) sendValues (projectId);
				});
			}
			else
			{
				sendingValues = 0;
			}
		});
	}
	else
	{
		debug ('Already sending signals');
		storedValues = true;
	}
}

// setInterval (function ()
// {
// 	send ('i', {c:boardtype.toString()});
// }, 1000);

