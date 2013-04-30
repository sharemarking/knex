
var sqlite3 = require('sqlite3');

var _ = require('underscore');
var util = require('util');
var genericPool = require('generic-pool');

var init, debug, pool, connection, connectionSettings;

// Initializes the sqlite3 module with an options hash,
// containing the connection settings, as well as the
// pool config settings
exports.initialize = function (options) {

  // If there isn't a connection setting
  if (!options.connection) return;

  connectionSettings = options.connection;
  debug = options.debug;

  // If pooling is disabled, set the query getter to
  // something below and create a connection on the connection object
  if (options.pool === false) {
    pool = false;
    connection = this.getConnection();
    return;
  }

  // Extend the genericPool with the options
  // passed into the init under the "pool" option
  pool = genericPool.Pool(_.extend({
    name : 'sqlite3',
    create : function(callback) {
      var conn = exports.getConnection();
      // Set to allow multiple connections on the database.
      conn.run("PRAGMA journal_mode=WAL;", function () {
        callback(null, conn);
      });
    },
    destroy  : function(client) {
      client.close();
    },
    max : 10,
    min : 2,
    idleTimeoutMillis: 30000,
    log : false
  }, options.pool));
};

exports.query = function (querystring, params, callback, connection, type) {

  // If there is a connection, use it.
  if (connection) {
    return connection.run(querystring, params, callback);
  }

  // Acquire connection - callback function is called
  // once a resource becomes available.
  pool.acquire(function(err, client) {

    if (err) throw new Error(err);
    var method = (type === 'insert' || type === 'update') ? 'run' : 'all';

    // Call the querystring and then release the client
    client[method](querystring, params, function (err, resp) {
      if (_.has(this, 'lastID')) resp = {insertId: this.lastID, changes: this.changes};
      pool.release(client);
      callback.call(this, err, resp);
    });

  });

};

// Returns a mysql connection, with a __cid property uniquely
// identifying the connection.
exports.getConnection = function () {
  var connection = new sqlite3.Database(connectionSettings.filename);
  connection.__cid = _.uniqueId('__cid');
  return connection;
};

// Extends the standard sql grammar.
var grammar = exports.grammar = {

  // The keyword identifier wrapper format.
  wrapValue: function(value) {
    return (value !== '*' ? util.format('"%s"', value) : "*");
  },

  // Compile the "order by" portions of the query.
  compileOrders: function(qb, orders) {
    if (orders.length === 0) return;
    return "order by " + orders.map(function(order) {
      return this.wrap(order.column) + " collate nocase " + order.direction;
    }, this).join(', ');
  },

  // Compile an insert statement into SQL.
  compileInsert: function(qb, values) {
    if (!_.isArray(values)) values = [values];
    var table = this.wrapTable(qb.table);
    var parameters = this.parameterize(values[0]);
    var paramBlocks = [];

    // If there is only one record being inserted, we will just use the usual query
    // grammar insert builder because no special syntax is needed for the single
    // row inserts in SQLite. However, if there are multiples, we'll continue.
    if (values.length === 1) {
      return require('../knex').Grammar.prototype.compileInsert.call(this, qb, values);
    }
    
    var keys = _.keys(values[0]);
    var names = this.columnize(keys);
    var columns = [];

    // SQLite requires us to build the multi-row insert as a listing of select with
    // unions joining them together. So we'll build out this list of columns and
    // then join them all together with select unions to complete the queries.
    for (var i = 0, l = keys.length; i < l; i++) {
      var column = keys[i];
      columns.push('? as ' + this.wrap(column));
    }

    var joinedColumns = columns.join(', ');
    columns = [];
    for (i = 0, l = values.length; i < l; i++) {
      columns.push(joinedColumns);
    }

    return "insert into " + table + " (" + names + ") select " + columns.join(' union select ');
  },

  // Compile a truncate table statement into SQL.
  compileTruncate: function (qb) {
    var sql = {};
    sql['delete from sqlite_sequence where name = ?'] = [qb.from];
    sql['delete from ' + this.wrapTable(query.from)] = [];
    return sql;
  }
};

// Grammar for the schema builder.
exports.schemaGrammar = _.extend({}, grammar, {
  
  // The possible column modifiers.
  modifiers: ['Nullable', 'Default', 'Increment'],
  
  // Compile the query to determine if a table exists.
  compileTableExists: function() {
    return "select * from sqlite_master where type = 'table' and name = ?";
  },

  // Compile a create table command.
  compileCreateTable: function(blueprint, command) {
    var columns = this.getColumns(blueprint).join(', ');
    var sql = 'create table ' + this.wrapTable(blueprint) + ' (' + columns;
    
    // SQLite forces primary keys to be added when the table is initially created
    // so we will need to check for a primary key commands and add the columns
    // to the table's declaration here so they can be created on the tables.
    sql += this.addForeignKeys(blueprint);
    sql += this.addPrimaryKeys(blueprint) || '';
    sql +=')';
    return sql;
  },

  // Get the foreign key syntax for a table creation statement.
  // Once we have all the foreign key commands for the table creation statement
  // we'll loop through each of them and add them to the create table SQL we
  // are building, since SQLite needs foreign keys on the tables creation.
  addForeignKeys: function(blueprint) {
    var sql = '';
    var foreigns = this.getCommandsByName(blueprint, 'foreign');
    for (var i = 0, l = foreigns.length; i < l; i++) {
      var foreign = foreigns[i];
      var on = this.wrapTable(foreign.on);
      var columns = this.columnize(foreign.columns);
      var onColumns = this.columnize(foreign.references);
      sql += ', foreign key(' + columns + ') references ' + on + '(' + onColumns + ')';
    }
    return sql;
  },
  
  // Get the primary key syntax for a table creation statement.
  addPrimaryKeys: function(blueprint) {
    var primary = this.getCommandByName(blueprint, 'primary');
    if (primary) {
      var columns = this.columnize(primary.columns);
      return ', primary key (' + columns + ')';
    }
  },

  // Compile alter table commands for adding columns
  compileAdd: function(blueprint, command) {
    var table = this.wrapTable(blueprint);
    var columns = this.prefixArray('add column', this.getColumns(blueprint));
    var statements = [];
    for (var i = 0, l = columns.length; i < l; i++) {
      statements.push('alter table ' + table + ' ' + columns[i]);
    }
    return statements;
  },

  // Compile a unique key command.
  compileUnique: function(blueprint, command) {
    var columns = this.columnize(command.columns);
    var table = this.wrapTable(blueprint);
    return 'create unique index ' + command.index + ' on ' + table + ' (' + columns + ')';
  },
  
  // Compile a plain index key command.
  compileIndex: function(blueprint, command) {
    var columns = this.columnize(command.columns);
    var table = this.wrapTable(blueprint);
    return 'create index ' + command.index + ' on ' + table + ' (' + columns + ')';
  },
  
  // Compile a foreign key command.
  compileForeign: function(blueprint, command) {
    // Handled on table creation...
  },
  
  // Compile a drop table command.
  compileDropTable: function(blueprint, command) {
    return 'drop table ' + this.wrapTable(blueprint);
  },

  // Compile a drop table (if exists) command.
  compileDropTableIfExists: function(blueprint, command) {
    return 'drop table if exists ' + this.wrapTable(blueprint);
  },
  
  // Compile a drop column command.
  compileDropColumn: function(blueprint, command) {
    throw new Error("Drop column not supported for SQLite.");
  },
  
  // Compile a drop unique key command.
  compileDropUnique: function(blueprint, command) {
    return 'drop index ' + command.index;
  },
  
  // Compile a drop index command.
  compileDropIndex: function(blueprint, command) {
    return 'drop index ' + command.index;
  },

  // Compile a rename table command.
  compileRename: function(blueprint, command) {
    return 'alter table ' + this.wrapTable(blueprint) + ' rename to ' + this.wrapTable(command.to);
  },
  
  // Create the column definition for a string type.
  typeString: function(column) {
    return 'varchar';
  },
  
  // Create the column definition for a text type.
  typeText: function(column) {
    return 'text';
  },
  
  // Create the column definition for a integer type.
  typeInteger: function(column) {
    return 'integer';
  },
  
  // Create the column definition for a float type.
  typeFloat: function(column) {
    return 'float';
  },
  
  // Create the column definition for a decimal type.
  typeDecimal: function(column) {
    return 'float';
  },
  
  // Create the column definition for a boolean type.
  typeBoolean: function(column) {
    return 'tinyint';
  },
  
  // Create the column definition for a enum type.
  typeEnum: function(column) {
    return 'varchar';
  },
  
  // Create the column definition for a date type.
  typeDate: function(column) {
    return 'date';
  },
  
  // Create the column definition for a date-time type.
  typeDateTime: function(column) {
    return 'datetime';
  },
  
  // Create the column definition for a time type.
  typeTime: function(column) {
    return 'time';
  },
  
  // Create the column definition for a timestamp type.
  typeTimestamp: function(column) {
    return 'datetime';
  },
  
  // Create the column definition for a binary type.
  typeBinary: function(column) {
    return 'blob';
  },
  
  // Get the SQL for a nullable column modifier.
  modifyNullable: function(blueprint, column) {
    return column.nullable ? ' null' : ' not null';
  },
  
  // Get the SQL for a default column modifier.
  modifyDefault: function(blueprint, column) {
    if (column.defaultValue) {
      return " default '" + this.getDefaultValue(column.defaultValue) + "'";
    }
  },
  
  // Get the SQL for an auto-increment column modifier.
  modifyIncrement: function(blueprint, column) {
    if (column.type == 'integer' && column.autoIncrement) {
      return ' primary key autoincrement';
    }
  }
});