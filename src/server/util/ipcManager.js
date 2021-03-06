/*
	ipcManager.js
	Integrates with web server and runs the server.
	Connected to by the Polaris bot.
	Authored by Neztore.
*/
// Cache for isIn requests. Only 5 min.


const isInCache = new Map();
const getRolesCache = new Map();
setInterval(()=> {
	isInCache.clear();
	getRolesCache.clear();
	console.log(`IPC cache cleared!`);
}, 300000); // 5min





var IPC = require('node-ipc');

IPC.config.id = 'polarisServer';
IPC.config.retry = 1500;
IPC.config.silent = true;

var client;
// When server starts
IPC.serve(function() {
	IPC.server.on('connect', function(socket) {
		client = socket;
		console.log(`IPC: Client connected`);
	}
	);
	IPC.server.on('socket.disconnected', function() {
		console.log('IPC: client has disconnected!');
		client = undefined;
	});
	IPC.server.on('error', function(error){
		throw new Error(error);
	});
});


module.exports = {
	isIn: isIn,
	getRoles: getRoles
};

function isIn(guildId) {
	return new Promise (function(resolve, reject){
		if (isInCache.get(guildId)) {
			resolve(isInCache.get(guildId));
		}
		if (client) {
			makeRequest(client, "botCheck", {data: {guildId: guildId}})
				.then(m => resolve(m.data))
				.catch(reject);
		} else {
			console.log(`IPC: No client. Attempting to wait for socket re-connection.`);

			// Rejects if no connection after 15 seconds. Client should only ever be offline for a couple of seconds.
			const wait = setTimeout(function(){
				reject({error: {status: 503, message: "Polaris Bot unavailable. Please try again later."}});
			}, 15000);

			IPC.server.on('connect', async function a(socket) {
				IPC.server.off('connect', a);
				const msg = await makeRequest(socket, "botCheck", {data: {guildId: guildId}});
				// Remove listener on connect
				IPC.server.off('connect', a);
				// Remove no connection error
				clearTimeout(wait);
				isInCache.set(guildId, msg.data);
				resolve(msg.data);
			});

		}
	});
}

function getRoles(guildId) {
	return new Promise (function(resolve, reject){
		if (getRolesCache.get(guildId)) {
			resolve(isInCache.get(guildId));
		}
		if (client) {
			makeRequest(client, "getRoles", {data: {guildId: guildId}})
				.then(m => resolve(m.data))
				.catch(reject);
		} else {
			console.log(`IPC: No client. Attempting to wait for socket re-connection.`);

			// Rejects if no connection after 15 seconds. Client should only ever be offline for a couple of seconds.
			const wait = setTimeout(function(){
				reject({error: {status: 503, message: "Polaris Bot unavailable. Please try again later."}});
			}, 15000);

			IPC.server.on('connect', async function b(socket) {
				const msg = await makeRequest(socket, "getRoles", {data: {guildId: guildId}});
				// Remove listener on connect
				IPC.server.off('connect', b);
				// Remove no connection error
				clearTimeout(wait);
				getRolesCache.set(guildId, msg.data);
				resolve(msg.data);
			});

		}
	});
}

// Function used to make a request to the Polaris client, and await the response.
function makeRequest(client, type, data) {
	return new Promise (function(resolve)
	{

		const id = generateId();
		data._id = id;

		IPC.server.emit(client, type, JSON.stringify(data));
		var typeName = type + "Res";
		IPC.server.on(typeName, function hm(msg) {
			msg = JSON.parse(msg);

			if (msg._id === id) {
				// Version of remove event listener for the disasterous implementation of events by the lib author. WHY????
				IPC.server.off(typeName, hm);
				resolve(msg);
			}
		});
	});
}

// Function which returns a unique indentifier to use to identify requests. Maxes at 1000, though its unlikely that number will be reached.
let lastId = 0;
const generateId = function () {
	lastId += 1;
	if (lastId > 1000) {
		console.log(`IPC: Id reached 1000. Reset!`);
		lastId = 0;
	}
	return lastId;
};



IPC.server.start();
