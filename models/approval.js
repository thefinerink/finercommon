const dbcmd = require('../utils/dbcommand'),
  md5 = require('md5'),
  extend = require('extend'),
  tablename = 'approvals',
  shortid = require('shortid'),
  Organization = require('../models/organization'),
  Email = require('../models/email'),
  CRMIntegrations = require('../models/crmintegrations');

/**
* The account class
*/
var Approval = function (details) {
  extend(this, details || {});
};

/**
 * States
 */
Approval.SEND_STATES = {
  UNSENT: 0,
  SENT: 1
};

/**
 * Send SMS or Email if necessary
 */
Approval.prototype.execute = function (cfg, cb) {
  if (this.sendState == Approval.SEND_STATES.UNSENT) {
    this.sendState = Approval.SEND_STATES.SENT;

    // Invite updated! Send an updated email
    let emailCtrl = new Email(cfg.email.server, cfg.email.port, cfg.email.key, cfg.email.secret);
    /*emailCtrl.send(cfg.email.defaultFrom, email, 'invitetoorg', 'Your invitation to join ' + org.name + ' on FinerInk has been updated.', {
      account: act,
      invite: ivt,
      org: org,
      ivturl: pjson.config.portalUrl + "/account/finish/?ivt=" + encodeURIComponent(ivt.uid)
    }, function (err) {
      if (err) {
        console.log("Error sending invitation email", err);
        callback("Error sending invitation email");
      } else {
        // Success
        callback(null, ivt);
      }
    });*/

    //this.commit(cfg, cb);
  } else {
    process.nextTick(cb);
  }
};

/**
* Save any changes to the DB row
*/
Approval.prototype.commit = function (cfg, cb) {
  cb = cb || function () {};
  var excludes = [
      'id', 'created_at'
    ],
    valKeys = Object.keys(this),
    query = 'UPDATE ' + cfg.db.db + '.' + tablename + ' SET ',
    params = [],
    count = 0;
  this.updated_at = new Date();
  for (var elm in valKeys) {
    if (excludes.indexOf(valKeys[elm]) == -1) {
      if (count > 0) {
        query += ', ';
      }
      query += valKeys[elm] + ' = ?';
      params.push(this[valKeys[elm]]);
      count++;
    }
  }
  query += ' WHERE guid = ?';
  params.push(this.guid);

  dbcmd.cmd(cfg.pool, query, params, function (result) {
    cb(null, this);
  }, function (err) {
    cb(err);
  });
};

/**
* Get an approval by its id
*/
Approval.GetByGuid = function (cfg, guid, cb) {
  cb = cb || function () {};
  dbcmd.cmd(cfg.pool, 'SELECT * FROM ' + cfg.db.db + '.' + tablename + ' WHERE guid = ?', [guid], function (result) {
    cb(result.length === 0
      ? {
        message: "No approval found."
      }
      : null, result.length > 0
      ? new Approval(result[0])
      : null);
  }, function (err) {
    cb(err);
  });
};

/**
* Get an approval by its oppportunity ID and contact
*/
Approval.GetByOppAndContact = function (cfg, opportunity_id, crm_contact_id, cb) {
  cb = cb || function () {};
  dbcmd.cmd(cfg.pool, 'SELECT * FROM ' + cfg.db.db + '.' + tablename + ' WHERE opportunity_id = ? AND crm_contact_id = ? LIMIT 1', [
    opportunity_id, crm_contact_id
  ], function (result) {
    if (result && result.length > 0) {
      cb(null, new Approval(result[0]));
    } else {
      cb();
    }
  }, function (err) {
    cb(err);
  });
};

/**
* Delete all
*/
Approval.DeleteAll = function (cfg, cb) {
  cb = cb || function () {};
  dbcmd.cmd(cfg.pool, 'DELETE FROM ' + cfg.db.db + '.' + tablename + ' WHERE guid NOT NULL', function () {
    cb();
  }, function (err) {
    cb(err);
  });
};

/**
* Create an approval
*/
Approval.Create = function (cfg, details, cb) {
  cb = cb || function () {};
  details = details || {};
  var _Defaults = {
    guid: shortid.generate(),
    created_at: new Date(),
    updated_at: new Date(),
    sendState: Approval.SEND_STATES.UNSENT,
    sendEmail: 0,
    sendSMS: 0,
    created_by_account_id: 0,
    organization_id: 0,
    opportunity_id: "",
    crm_contact_id: 0
  };
  extend(_Defaults, details);
  var valKeys = Object.keys(_Defaults),
    query = 'INSERT INTO ' + cfg.db.db + '.' + tablename + ' SET ',
    params = [],
    count = 0;
  for (var elm in valKeys) {
    if (count > 0) {
      query += ', ';
    }
    query += valKeys[elm] + ' = ?';
    params.push(_Defaults[valKeys[elm]]);
    count++;
  }
  dbcmd
    .cmd(cfg.pool, query, params, function (result) {
      Approval
        .GetByGuid(cfg, _Defaults.guid, function (err, user) {
          if (err) {
            cb(err);
          } else {
            cb(null, user);
          }
        });
    }, function (err) {
      cb(err);
    });
};

// Expose it
module.exports = Approval;