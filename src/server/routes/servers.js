// /servers/ route. Provides server settings, and user guild lists.
const express = require('express');
const router = express.Router();

const { catchAsync, getUserServers } = require('../util/discordHTTP');
const IPC = require('../util/ipcManager');
const config = require('../config.js');
const rateLimit = require('../ratelimit');

const r = require('rethinkdbdash')({db: 'main'});
const serversTable = r.db('main').table('servers');

const { escape, isNumeric, isLength } = require('validator');

// Ratelimit & authorization check:

router.use(rateLimit);

router.get('/', catchAsync(async function(req, res){
	const allowedServers = await getUserServers(req.headers.authorization);
	if (allowedServers.error) {
		res.status(allowedServers.error.status).send(allowedServers);
	} else {
		res.send(allowedServers);
	}
}));
// /servers/:id
router.get('/:id', catchAsync(async function(req, res) {
	// Check for auth
	if (req.params.id) {
		// Param validation
		if (!validNum(req.params.id)) {
			return res.status(400).send({error: {status: 400, message: 'Server id must be a number.'}});
		}

		const servers = await getUserServers(req.headers.authorization);
		if (servers.error) {
			res.status(servers.error.status).send(servers.error);
			return;
		}

		// Find target server
		let targetServer;
		for (let currentServer of servers) {
			if (currentServer.id === req.params.id) {
				targetServer = currentServer;
			}
		}
		if (!targetServer) {
			return res.status(403).send({error: {status: 403, message: 'User is not in target guild, or does not have permission'}});
		}
		try {
			const isIn = await IPC.isIn(req.params.id);
			if (!isIn) {
				res.send({error: {status: 400, message: "NotInServer",
					redirect: {
						url: `${config.botInvite}&guild_id=${req.params.id}`,
						newTab: true
					}
				}});
				return;
			}
		} catch (err) {
			res.status(503).send({error: {status: 503, message: "Service Unavailable. Please re-try in 5 minutes."}});
			return;
		}

		// validate auth/ get user servers. This should be moved to the DB class in future?

		const record = await serversTable.get(req.params.id);
		if (record) {
			return res.send(record);
		} else {
			res.status(404);
			res.send({error: { message: "Server not found. Please run a command in the server first.", status: 404}});
		}
	} else {
		res.status(400);
		res.send({error: { message: "Bad request!", status: 400}});
	}
}));

// EDIT SERVER SETTINGS
// Post as it's editing.
// /servers/:id
router.post('/:id', catchAsync(async function(req, res) {
	// Param validation
	if (!req.body || !req.body.newSetting) {
		return res.status(400).send({error: {status: 400, message: 'newSetting is required'}});
	}
	if (!validNum(req.params.id)) {
		return res.status(400).send({error: {status: 400, message: 'Server id must be a number'}});
	}
	// Get all user's servers
	const servers = await getUserServers(req.headers.authorization);
	if (servers.error) {
		res.status(servers.error.status).send(servers.error);
		return;
	}

	// Find target server
	let targetServer;
	for (let currentServer of servers) {
		if (currentServer.id === req.params.id) {
			targetServer = currentServer;
		}
	}
	if (!targetServer) {
		return res.status(403).send({error: {status: 403, message: 'User is not in target guild, or does not have permission'}});
	}

	// Check if bot is in the server or not.
	if (!await IPC.isIn(req.params.id)) {
		res.send({error: {status: 400, message: "NotInServer", redirect: config.botInvite}});
		return;
	}
	// Extract the wanted settings from their provided object. Validate too. newObj will be current settings?
	let newObj = {};
	// CONVERT TO NEW DB!!
	const currentSettings = await r.db('main').table('servers').get(req.params.id) || {};
	let oldObj = req.body.newSetting;
	let errors = [];
	// Validate mainGroup obj
	if (oldObj.mainGroup !== undefined) {
		if (oldObj.mainGroup === false) {
			newObj.mainGroup = {};

		}
		const result = checkGroup(oldObj.mainGroup,  currentSettings);
		if (result.errors) {
			errors = errors.concat(result.errors);
		} else {
			newObj.mainGroup = result;
		}
	}
	if (oldObj.subGroups && Array.isArray(oldObj.subGroups)) {
		// This used to combine "current" groups and new. That isn't needed. Why?
		// This replaces all the current groups anyway.
		let totalSubs = oldObj.subGroups.length;
		if (totalSubs > 14) {
			errors.push({valueName: 'subGroups', value: oldObj.subGroups, message: 'Only 4 subGroups are allowed.'});
		} else {
			if (!newObj.subGroups) newObj.subGroups = [];
			for (var counter = 0; counter < oldObj.subGroups.length; counter++) {
				let currentGroup = oldObj.subGroups[counter];
				const result = checkGroup(currentGroup, currentSettings);
				if (result.errors) {
					errors = errors.concat(result.errors);
				} else {
					newObj.subGroups[counter] = result;
				}
			}
		}
	}
	if (oldObj.nicknameTemplate) {
		if (oldObj.nicknameTemplate === "") {
			newObj.nicknameTemplate = false;
		} else {
			if (typeof oldObj.nicknameTemplate === "string" && oldObj.nicknameTemplate.length < 35) {
				let newNick = escape(oldObj.nicknameTemplate);
				newObj.nicknameTemplate = newNick;
			} else {
				errors.push({valueName: `nicknameTemplate`, value: oldObj.nicknameTemplate, message: 'nicknameTemplate value must be a string under 35 characters.'});
			}
		}

	}


	// auto verify?
	if (oldObj.autoVerify !== undefined) {
		if (validBool(oldObj.autoVerify)){
			newObj.autoVerify = oldObj.autoVerify;
		} else {
			errors.push({valueName: `autoVerify`, value: oldObj.autoVerify, message: 'autoVerify value must be a boolean.'});
		}
	}
	//  prefix
	if (oldObj.prefix !== undefined) {
		if (oldObj.prefix === false) {
			newObj.prefix = `.`;
		} else {
			let newP = escape(oldObj.prefix);
			if (isLength(newP, {min: 0, max: 2})) {
				newObj.prefix = newP;
			} else {
				errors.push({valueName: `prefix`, value: oldObj.prefix, message: 'prefix value can be up to 2 characters or false. No HTML entities.'});
			}
		}
	}

	if (errors.length !== 0) {
		return res.status(400).send({error: {status: 400, message: 'Invalid request. See errors array.', errors: errors}});
	} else {
		// DB!
		let alreadySet = await serversTable.get(req.params.id);
		try {
			if (alreadySet) {
				let resp = await serversTable.get(req.params.id).update(newObj, {
					returnChanges: true
				});
				if (resp.errors !== 0) {
					res.status(500).send({error: {status: 500, message: resp.first_error}});
					throw new Error(resp.first_error);
				}
				res.status(200).send({status: 200, message: "Updated", newSettings: await serversTable.get(req.params.id) });
			} else {
				res.status(500).send({error: {status: 500, message: "Database error: Server does not have record. "}});
				throw new Error("Database error: Server does not have record.");
			}
		} catch (err) {
			res.status(500).send({error: {status: 500, message: err.message}});
			throw new Error(err);
		}


	}



}));

// GET SERVER SETTINGS
router.get('/:id/roles', catchAsync(async function(req, res) {
	// Check for auth
	if (req.params.id) {
		const resp = await IPC.getRoles(req.params.id);
		if (resp.error) {
			res.status(res.error.status).send(resp);
			return;
		}
		res.send(resp);
	}
}));



const validNum     = (num)    => !isNaN(num);
const validBool    = (bool)   => typeof(bool) === "boolean";
const validDiscord = (s)=> isNumeric(s, {no_symbols: true});

const checkGroup = (group) => {
	const errors = [];
	const newObj = {};
	if (group) {
		// Validate Group id
		if (group.id) {
			if (validNum(group.id)) {
				newObj.id = parseInt(group.id, 10);
			} else {
				// Id is not valid
				errors.push({valueName: 'group id', value: group.id, message: 'group.id must be a number'});
				return false;
			}
		}
		// Validate Group ranksToRoles
		if (group.ranksToRoles !== undefined) {
			if (validBool(group.ranksToRoles)) {
				newObj.ranksToRoles = group.ranksToRoles;
			} else {
				errors.push({valueName: 'group.ranksToRoles', value: group.ranksToRoles, message: 'group.ranksToRoles must be a boolean'});
			}
		}
		// Validate Group binds (NEW)
		let validBinds = [];
		if (group.binds && Array.isArray(group.binds)) {
			for (var count = 0; count < group.binds.length; count++) {

				let bind = group.binds[count];

				if (bind !== undefined && bind.rank  !== undefined && bind.role !== undefined) {
					if (!validNum(bind.rank) || parseInt(bind.rank, 10) > 255 || parseInt(bind.rank, 10) < 0) {

						errors.push({valueName: `group.binds[${count}].rank`, value: bind.rank, message: 'group.binds rank value must be a number between 0 and 255.', position: count});

					} else if (typeof bind.role !== "string" || !validDiscord(bind.role)) {
						errors.push({
							valueName: `group.binds[${count}].role`,
							value: bind.role,
							message: 'group.binds role value must be a string of numbers',
							position: count
						});
					} else if (bind.exclusive !== undefined && !validBool(bind.exclusive)) {
						errors.push({
							valueName: `group.binds[${count}].exclusive`,
							value: bind.exclusive,
							message: 'group.binds exclusive value must be a bool',
							position: count
						});
					} else {
						// Both role and rank have passed tests. Add it :D
						validBinds.push(bind);
					}


				} else {

					errors.push({valueName: `group.binds[${count}]`, value: bind, message: 'group.binds values must have both rank and role values.', position: count});


				}
			}
			newObj.binds = validBinds;
		}
	}

	// Will be replacing old binds; binds will be part of sub-groups
	// Binds: array of {role: "312312313", rank: number, exclusive: bool}
	if (errors.length !== 0) {
		return {errors};
	} else {
		return newObj;

	}
};





module.exports = router;
