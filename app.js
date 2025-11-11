require('dotenv').config();
const express = require('express');
const path = require('path');
const snowflake = require('snowflake-sdk');
const fileUpload = require('express-fileupload');
const AWS = require('aws-sdk');
const axios = require('axios');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(fileUpload());





// Serve static frontend (login + dashboard)
app.use(express.static(path.join(__dirname, 'public')));

// -------------------- SNOWFLAKE CONNECTION --------------------
const connection = snowflake.createConnection({
  account: process.env.SNOWFLAKE_ACCOUNT,
  username: process.env.SNOWFLAKE_USERNAME,
  password: process.env.SNOWFLAKE_PASSWORD,
  warehouse: process.env.SNOWFLAKE_WAREHOUSE,
  database: process.env.SNOWFLAKE_DATABASE,
  schema: process.env.SNOWFLAKE_SCHEMA,
  role: process.env.SNOWFLAKE_ROLE,
});

// Connect to Snowflake
connection.connect((err, conn) => {
  if (err) {
    console.error('❌ Unable to connect to Snowflake:', err.message);
  } else {
    console.log('✅ Connected to Snowflake successfully!');
  }
});

// -------------------- AWS S3 CONFIG --------------------
AWS.config.update({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION
});

const s3 = new AWS.S3();
const S3_BUCKET = process.env.S3_BUCKET;

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// -------------------- LOGIN ENDPOINT --------------------
app.post('/login', (req, res) => {
  const { email, password } = req.body;

  // Simple mock authentication (replace later with real Snowflake/IICS table validation)
  if (email === 'admin@guardian.com' && password === 'admin123') {
    res.redirect('/dashboard.html');
  } else {
    res.send(`<h3>Invalid credentials. <a href="/">Try again</a></h3>`);
  }
});

// -------------------- SNOWFLAKE DASHBOARD ROUTES --------------------

// 1️⃣ Get Snowflake version (for debugging)
app.get('/api/version', (req, res) => {
  connection.execute({
    sqlText: 'SELECT CURRENT_VERSION() AS VERSION;',
    complete: (err, stmt, rows) => {
      if (err) {
        console.error('❌ Error fetching version:', err.message);
        res.status(500).send('Error running query');
      } else {
        res.json(rows[0]);
      }
    },
  });
});

// 2️⃣ Warehouse Status
// app.get('/api/warehouse-status', (req, res) => {
//   connection.execute({
//     sqlText: "SHOW WAREHOUSES;",
//     complete: (err, stmt, rows) => {
//       if (err) {
//         console.error('❌ Error fetching warehouse info:', err.message);
//         res.status(500).send('Error fetching warehouse');
//       } else {
//         const wh = rows.find((w) => w.name === process.env.SNOWFLAKE_WAREHOUSE);
//         res.json({ name: wh.name, state: wh.state });
//       }
//     },
//   });
// });
app.get('/api/resource-monitor', (req, res) => {
  const sql = "SHOW RESOURCE MONITORS;";
  connection.execute({
    sqlText: sql,
    complete: (err, stmt, rows) => {
      if (err) {
        console.error('❌ Error fetching resource monitor:', err.message);
        res.status(500).send('Error fetching monitor data');
      } else {
        const monitor = rows.find(m => m.name === 'MONITOR_INSURANCE');
        if (monitor) {
          const used = monitor.used_credits || 0;
          const quota = monitor.credit_quota || 100;
          const percent = ((used / quota) * 100).toFixed(1);

          res.json({
            name: monitor.name,
            usedCredits: used,
            creditQuota: quota,
            remainingCredits: monitor.remaining_credits,
            percentUsed: percent,
            frequency: monitor.frequency,
            startTime: monitor.start_time,
            endTime: monitor.end_time || 'Cycle Active',
            notifyAt: monitor.notify_at,
            suspendAt: monitor.suspend_at,
            suspendImmediateAt: monitor.suspend_immediately_at,
            createdOn: monitor.created_on,
            owner: monitor.owner,
            notifyUsers: monitor.notify_users
          });
        } else {
          res.json({ message: 'Resource monitor not found.' });
        }
      }
    }
  });
});



app.get('/get-env-details', (req, res) => {
  const sql = `SELECT CURRENT_ROLE() AS role,
                      CURRENT_WAREHOUSE() AS warehouse,
                      CURRENT_DATABASE() AS database,
                      CURRENT_SCHEMA() AS schema;`;

  connection.execute({
    sqlText: sql,
    complete: (err, stmt, rows) => {
      if (err) {
        console.error('❌ Error fetching environment details:', err.message);
        res.status(500).send('Error fetching environment details');
      } else {
        res.json(rows[0]);
      }
    },
  });
});


app.get('/get-stages', (req, res) => {
  const sql = "SHOW STAGES IN SCHEMA insurance_group_db.insurance_group_schema;";
  connection.execute({
    sqlText: sql,
    complete: function(err, stmt, rows) {
      if (err) {
        console.error('❌ Error fetching stages:', err.message);
        res.status(500).send('Error fetching stages');
      } else {
        res.json(rows);
      }
    }
  });
});


// 4️⃣ Snowpipe  data
app.get('/get-pipes', (req, res) => {
  const sql = "SHOW PIPES IN SCHEMA INSURANCE_GROUP_DB.INSURANCE_GROUP_SCHEMA;";
  connection.execute({
    sqlText: sql,
    complete: async function (err, stmt, rows) {
      if (err) {
        console.error('❌ Error fetching pipes:', err.message);
        res.status(500).send('Error fetching pipes');
        return;
      }

      // Fetch extra info for each pipe
      const detailedPipes = await Promise.all(rows.map(async (pipe) => {
        const pipeName = pipe.name;
        let statusInfo = {};
        try {
          const statusSql = `SELECT SYSTEM$PIPE_STATUS('${pipeName}') AS STATUS;`;
          const statusRows = await new Promise((resolve, reject) => {
            connection.execute({
              sqlText: statusSql,
              complete: (e, s, r) => (e ? reject(e) : resolve(r))
            });
          });

          const statusJson = JSON.parse(statusRows[0].STATUS);
          statusInfo = {
            state: statusJson.executionState || 'UNKNOWN',
            lastLoadTime: statusJson.lastIngestedTimestamp || '—'
          };
        } catch {
          statusInfo = { state: 'ERROR', lastLoadTime: '—' };
        }

        return {
          name: pipe.name,
          created_on: pipe.created_on,
          status: statusInfo.state,
          last_load: statusInfo.lastLoadTime
        };
      }));

      res.json(detailedPipes);
    }
  });
});



// -------------------- ROUTE: Upload File to S3 --------------------
app.post('/upload-s3', async (req, res) => {
  try {
    if (!req.files || !req.files.file) {
      return res.status(400).json({ message: 'No file uploaded' });
    }

    const file = req.files.file;
    const uploadParams = {
      Bucket: S3_BUCKET,
      Key: `src/${Date.now()}_${file.name}`,
      Body: file.data,
      ContentType: file.mimetype
    };

    await s3.upload(uploadParams).promise();
    console.log(`📤 File uploaded: ${uploadParams.Key}`);

    res.json({ message: 'File uploaded to S3 successfully ✅' });
  } catch (error) {
    console.error('❌ S3 Upload error:', error);
    res.status(500).json({ message: 'Error uploading to S3' });
  }
});

// -------------------- ROUTE: Refresh Snowpipe --------------------
app.post('/refresh-pipe', (req, res) => {
  const sql = `ALTER PIPE FRAUDALERTPIPE REFRESH;`;

  connection.execute({
    sqlText: sql,
    complete: (err) => {
      if (err) {
        console.error('❌ Snowpipe refresh error:', err.message);
        res.status(500).json({ message: 'Failed to refresh pipe' });
      } else {
        console.log('🔄 Pipe refreshed successfully!');
        res.json({ message: 'Pipe refreshed successfully 🔄' });
      }
    }
  });
});

// -------------------- ROUTE: Get Row Count --------------------
app.get('/get-rowcount', (req, res) => {
  const sql = `SELECT COUNT(*) AS total FROM FRAUD_ALERTS;`;

  connection.execute({
    sqlText: sql,
    complete: (err, stmt, rows) => {
      if (err) {
        console.error('❌ Count query error:', err.message);
        res.status(500).json({ message: 'Error fetching row count' });
      } else {
        const count = rows[0].TOTAL || rows[0].TOTAL_COUNT || Object.values(rows[0])[0];
        console.log(`📊 Current row count: ${count}`);
        res.json({ after_count: count });
      }
    }
  });
});


// API to get table lists
app.get("/api/get-tables", async (req, res) => {
  const dimQuery = `SHOW TABLES LIKE 'DIM%' IN SCHEMA INSURANCE_GROUP_DB.INSURANCE_SCHEMA_FACT_TABLES;`;
  const factQuery = `SHOW TABLES LIKE 'FACT_%' IN SCHEMA INSURANCE_GROUP_DB.INSURANCE_SCHEMA_FACT_TABLES;`;

  try {
    const [dimResult, factResult] = await Promise.all([
      runQuery(dimQuery),
      runQuery(factQuery)
    ]);

    const dimensions = dimResult.map(row => row.name);
    const facts = factResult.map(row => row.name);

    res.json({ dimensions, facts });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error fetching tables");
  }
});

// Query selected table
app.get("/api/query", async (req, res) => {
  const table = req.query.table;
  if (!table) return res.status(400).send("Table name required");

  const query = `SELECT * FROM INSURANCE_GROUP_DB.INSURANCE_SCHEMA_FACT_TABLES.${table} limit 10;`;

  try {
    const rows = await runQuery(query);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).send("Error fetching table data");
  }
});

// Helper function
function runQuery(query) {
  return new Promise((resolve, reject) => {
    const result = [];
    connection.execute({
      sqlText: query,
      complete: (err, stmt, rows) => {
        if (err) reject(err);
        else resolve(rows);
      }
    });
  });
}

app.post('/run-custom-query', (req, res) => {
  const sql = req.body.query;
  connection.execute({
    sqlText: sql,
    complete: (err, stmt, rows) => {
      if (err) {
        res.status(400).json({ error: err.message });
      } else {
        res.json(rows);
      }
    }
  });
});

// Universal dynamic SQL executor (used by Phase 4 Masking Preview)
app.post('/run-query', (req, res) => {
  const { sql } = req.body;
  if (!sql) return res.status(400).send('SQL query missing.');

  connection.execute({
    sqlText: sql,
    complete: (err, stmt, rows) => {
      if (err) {
        console.error('❌ SQL Execution Error:', err.message);
        return res.status(500).send('Error executing query: ' + err.message);
      }
      res.json(rows);
    }
  });
});



/**
 * 1️⃣  Show all streams (from both schemas)
 */
app.get('/api/show-streams', async (req, res) => {
  const results = [];

  const queries = [
    `SHOW STREAMS IN SCHEMA INSURANCE_GROUP_DB.insurance_group_schema;`,
    `SHOW STREAMS IN SCHEMA INSURANCE_GROUP_DB.INSURANCE_SCHEMA_FACT_TABLES;`
  ];

  let completed = 0;

  queries.forEach(sql => {
    connection.execute({
      sqlText: sql,
      complete: (err, stmt, rows) => {
        completed++;
        if (err) {
          console.error('❌ SHOW STREAMS error:', err.message);
          return res.status(500).send('Error fetching streams');
        } else {
          results.push(...rows);
        }
        // When both finished, send response
        if (completed === queries.length) res.json(results);
      }
    });
  });
});


/**
 * 2️⃣  Show all tasks (main three)
 */
// app.get('/api/show-tasks', (req, res) => {
//   const sql = `
//     SHOW TASKS IN SCHEMA INSURANCE_GROUP_DB.INSURANCE_SCHEMA_FACT_TABLES;
//   `;

//   connection.execute({
//     sqlText: sql,
//     complete: (err, stmt, rows) => {
//       if (err) {
//         console.error('❌ SHOW TASKS error:', err.message);
//         return res.status(500).send('Error fetching tasks');
//       }

//       // Filter only the three main tasks you care about
//       const mainTasks = ['CLAIMS_INSERT_TASK', 'SETTLEMENT_UPDATE_TASK', 'FACTFRAUD_TASK'];
//       const filtered = rows.filter(r => mainTasks.includes(r.name));
//       res.json(filtered);
//     }
//   });
// });
app.get('/api/show-tasks', (req, res) => {
  const sql = `
    SHOW TASKS IN SCHEMA INSURANCE_GROUP_DB.INSURANCE_SCHEMA_FACT_TABLES;
  `;

  connection.execute({
    sqlText: sql,
    complete: (err, stmt, rows) => {
      if (err) {
        console.error('❌ SHOW TASKS error:', err.message);
        return res.status(500).send('Error fetching tasks');
      }

      // Filter to your 3 key tasks
      const mainTasks = ['CLAIMS_INSERT_TASK', 'SETTLEMENT_UPDATE_TASK', 'FACTFRAUD_TASK'];

      const formatted = rows
        .filter(r => mainTasks.includes(r.name))
        .map(r => ({
          name: r.name,
          schema: r.schema_name,
          warehouse: r.warehouse || '--',
          schedule: r.schedule || 'Manual / Hourly',
          state: r.state || '--',
          created_on: r.created_on,
          last_run: r.last_committed_on || '--',
          predecessors: r.predecessors || '--',
          owner: r.owner || '--'
        }));

      res.json(formatted);
    }
  });
});


/**
 * 3️⃣  Task history for a specific task
 */
app.get('/api/task-history/:taskName', (req, res) => {
  const taskName = req.params.taskName;

  // Only selecting universally available columns
  const sql = `
    SELECT 
      "NAME",
      "STATE",
      "QUERY_TEXT",
      "ERROR_MESSAGE",
      "SCHEDULED_TIME",
      "COMPLETED_TIME"
    FROM TABLE(INSURANCE_GROUP_DB.INFORMATION_SCHEMA.TASK_HISTORY())
    WHERE "NAME" ILIKE '${taskName}'
    ORDER BY "SCHEDULED_TIME" DESC
    LIMIT 10;
  `;

  connection.execute({
    sqlText: sql,
    complete: (err, stmt, rows) => {
      if (err) {
        console.error(`❌ TASK HISTORY error for ${taskName}:`, err.message);
        return res.status(500).send('Error fetching task history');
      }
      res.json(rows);
    }
  });
});





app.get('/api/show-mvs', (req, res) => {
  const sql = `
    SHOW MATERIALIZED VIEWS IN SCHEMA INSURANCE_GROUP_DB.insurance_group_schema;
  `;

  connection.execute({
    sqlText: sql,
    complete: (err, stmt, rows) => {
      if (err) {
        console.error('❌ SHOW MVs error:', err.message);
        return res.status(500).send('Error fetching materialized views');
      }

      const formatted = rows.map(r => ({
        name: r.name,
        schema_name: r.schema_name,
        database_name: r.database_name,
        created_on: r.created_on,
        refreshed_on: r.refreshed_on || '--',
        owner: r.owner || '--',
        invalid: r.invalid === 'Y' ? '❌ Invalid' : '✅ Valid',
        invalid_reason: r.invalid_reason || '',
        is_secure: r.is_secure,
        automatic_clustering: r.automatic_clustering || 'N',
        behind_by: r.behind_by || '0 sec',
        rows:r.rows
      }));

      res.json(formatted);
    }
  });
});

//------------------------------------------------------
// 🔹 Preview Stream Data
//------------------------------------------------------
app.get('/api/preview-stream/:name', (req, res) => {
  const streamName = req.params.name;
  const sql = `SELECT * FROM INSURANCE_GROUP_DB.insurance_group_schema.${streamName} LIMIT 20;`;

  connection.execute({
    sqlText: sql,
    complete: (err, stmt, rows) => {
      if (err) {
        console.error(`❌ Stream preview error (${streamName}):`, err.message);
        return res.status(500).send(`Error previewing stream: ${err.message}`);
      }
      res.json(rows);
    }
  });
});

//------------------------------------------------------
// 🔹 Preview Materialized View Data
//------------------------------------------------------
app.get('/api/preview-mv/:name', (req, res) => {
  const mvName = req.params.name;
  const sql = `SELECT * FROM INSURANCE_GROUP_DB.insurance_group_schema.${mvName} LIMIT 20;`;

  connection.execute({
    sqlText: sql,
    complete: (err, stmt, rows) => {
      if (err) {
        console.error(`❌ MV preview error (${mvName}):`, err.message);
        return res.status(500).send(`Error previewing MV: ${err.message}`);
      }
      res.json(rows);
    }
  });
});
// show all WAREHOUSES
app.get('/api/get-warehouses', (req, res) => {
  const sql = 'SHOW WAREHOUSES;';
  connection.execute({
    sqlText: sql,
    complete: (err, stmt, rows) => {
      if (err) {
        console.error('❌ SHOW WAREHOUSES error:', err.message);
        return res.status(500).send('Error fetching warehouses');
      }
      const names = rows.map(r => r.name);
      res.json(names);
    }
  });
});

//SHOW DATABASES
app.get('/api/get-databases', (req, res) => {
  const sql = 'SHOW DATABASES;';
  connection.execute({
    sqlText: sql,
    complete: (err, stmt, rows) => {
      if (err) {
        console.error('❌ SHOW DATABASES error:', err.message);
        return res.status(500).send('Error fetching databases');
      }
      const names = rows.map(r => r.name);
      res.json(names);
    }
  });
});
//'SHOW SCHEMAS
app.get('/api/get-schemas', (req, res) => {
  const sql = 'SHOW SCHEMAS;';
  connection.execute({
    sqlText: sql,
    complete: (err, stmt, rows) => {
      if (err) {
        console.error('❌ SHOW SCHEMAS error:', err.message);
        return res.status(500).send('Error fetching schemas');
      }
      const names = rows.map(r => r.name);
      res.json(names);
    }
  });
});

// 4️⃣ Get available roles
app.get('/api/get-roles', (req, res) => {
  const sql = 'SHOW ROLES;';
  connection.execute({
    sqlText: sql,
    complete: (err, stmt, rows) => {
      if (err) {
        console.error('❌ SHOW ROLES error:', err.message);
        return res.status(500).send('Error fetching roles');
      }
      const names = rows.map(r => r.name);
      res.json(names);
    }
  });
});

//This is what your “Set Context” button will call.

app.post('/api/set-context', (req, res) => {
  const { warehouse, database, schema, role } = req.body;

  const commands = [
    `USE WAREHOUSE ${warehouse};`,
    `USE DATABASE ${database};`,
    `USE SCHEMA ${schema};`,
    `USE ROLE ${role};`
  ];

  // Run commands sequentially
  (async () => {
    try {
      for (const cmd of commands) {
        await new Promise((resolve, reject) => {
          connection.execute({
            sqlText: cmd,
            complete: (err) => {
              if (err) {
                console.error(`❌ Error running ${cmd}:`, err.message);
                reject(err);
              } else {
                resolve();
              }
            }
          });
        });
      }
      res.send(`✅ Context successfully set to: 
Warehouse=${warehouse}, Database=${database}, Schema=${schema}, Role=${role}`);
    } catch (err) {
      res.status(500).send('Error setting context: ' + err.message);
    }
  })();
});


//Fetch All Masking Policies
app.get('/api/show-masking-policies', (req, res) => {
  const sql = `SHOW MASKING POLICIES;`;

  connection.execute({
    sqlText: sql,
    complete: (err, stmt, rows) => {
      if (err) {
        console.error('❌ SHOW MASKING POLICIES error:', err.message);
        return res.status(500).send('Error fetching masking policies');
      }

      const formatted = rows.map(r => ({
        name: r.name,
        database: r.database_name,
        schema: r.schema_name,
        expression: r.body,
        applies_to: r.kind || '--',
        owner: r.owner
      }));

      res.json(formatted);
    }
  });
});

app.get('/api/preview-masked-data/:policyName', (req, res) => {
  const policyName = req.params.policyName;
  const sqlFind = `
    SELECT POLICY_DB, POLICY_SCHEMA, POLICY_NAME, REF_DATABASE_NAME, REF_SCHEMA_NAME, REF_ENTITY_NAME
    FROM SNOWFLAKE.ACCOUNT_USAGE.POLICY_REFERENCES
    WHERE POLICY_NAME = '${policyName}'
    AND POLICY_KIND = 'MASKING_POLICY'
    LIMIT 1;
  `;

  connection.execute({
    sqlText: sqlFind,
    complete: (err, stmt, rows) => {
      if (err || !rows.length) {
        console.error('❌ Error finding policy reference:', err?.message);
        return res.status(500).send('No linked table found for this policy.');
      }

      const r = rows[0];
      const fullTable = `${r.REF_DATABASE_NAME}.${r.REF_SCHEMA_NAME}.${r.REF_ENTITY_NAME}`;
      res.json({ table: fullTable });
    }
  });
});

app.get('/api/show-row-policies', (req, res) => {
  const sql = `SHOW ROW ACCESS POLICIES;`;

  connection.execute({
    sqlText: sql,
    complete: (err, stmt, rows) => {
      if (err) {
        console.error('❌ SHOW ROW ACCESS POLICIES error:', err.message);
        return res.status(500).send('Error fetching row access policies');
      }

      const formatted = rows.map(r => ({
        name: r.name,
        database: r.database_name,
        schema: r.schema_name,
        expression: r.body || "--",
        owner: r.owner
      }));
    //   console.log(formatted)
      res.json(formatted);
    }
  });
});

app.get('/api/preview-row-policy/:policyName', (req, res) => {
  const policyName = req.params.policyName;

  const sqlFind = `
    SELECT POLICY_DB, POLICY_SCHEMA, POLICY_NAME, REF_DATABASE_NAME, REF_SCHEMA_NAME, REF_ENTITY_NAME
    FROM SNOWFLAKE.ACCOUNT_USAGE.POLICY_REFERENCES
    WHERE POLICY_NAME = '${policyName}'
    AND POLICY_KIND = 'ROW_ACCESS_POLICY'
    LIMIT 1;
  `;

  connection.execute({
    sqlText: sqlFind,
    complete: (err, stmt, rows) => {
      if (err || !rows.length) {
        console.error('❌ Error finding row policy link:', err?.message);
        return res.status(500).send('No linked table found for this policy.');
      }

      const r = rows[0];
      const fullTable = `${r.REF_DATABASE_NAME}.${r.REF_SCHEMA_NAME}.${r.REF_ENTITY_NAME}`;
      res.json({ table: fullTable });
    }
  });
});

app.get('/api/show-shares', (req, res) => {
  const sql = 'SHOW SHARES;';
  connection.execute({
    sqlText: sql,
    complete: (err, stmt, rows) => {
      if (err) {
        console.error('❌ SHOW SHARES error:', err.message);
        return res.status(500).send('Error fetching shares');
      }
      const formatted = rows.map(r => ({
        name: r.name,
        kind: r.kind,
        owner: r.owner,
        created_on: r.created_on,
        to: r.to,
        comment: r.comment
      }));
      res.json(formatted);
    }
  });
});


app.post('/api/create-share', (req, res) => {
  const { objectType, objectName, receiver } = req.body;

  if (!objectType || !objectName || !receiver) {
    return res.status(400).send('Missing parameters.');
  }

  const shareBaseName = objectName.split('.').pop().toUpperCase(); // e.g., FACTCLAIMS
  const shareName = `SHARE_${shareBaseName}_${Date.now()}`; // Unique name per creation

  // Break down objectName into DB.SCHEMA.OBJECT parts
  const parts = objectName.split('.');
  if (parts.length < 3) {
    return res.status(400).send('Invalid object name format. Use DB.SCHEMA.OBJECT');
  }
  const [db, schema, obj] = parts;

  // Build SQL commands in correct sequence
  const sqls = [
    `CREATE OR REPLACE SHARE ${shareName};`,
    `GRANT USAGE ON DATABASE ${db} TO SHARE ${shareName};`,
    `GRANT USAGE ON SCHEMA ${db}.${schema} TO SHARE ${shareName};`,
    `GRANT SELECT ON ${objectType} ${db}.${schema}.${obj} TO SHARE ${shareName};`,
    `ALTER SHARE ${shareName} ADD ACCOUNT = ${receiver};`
  ];

  (async () => {
    try {
      for (const sql of sqls) {
        await new Promise((resolve, reject) => {
          connection.execute({
            sqlText: sql,
            complete: (err) => {
              if (err) reject(err);
              else resolve();
            }
          });
        });
      }
      res.send(`✅ Secure Share "${shareName}" successfully created and shared with ${receiver}.`);
    } catch (err) {
      console.error('❌ Error creating share:', err.message);
      res.status(500).send('Error creating share: ' + err.message);
    }
  })();
});

app.post('/api/remove-share-account', (req, res) => {
  const { shareName, receiver } = req.body;
  if (!shareName || !receiver)
    return res.status(400).send('Missing shareName or receiver.');

  const sql = `ALTER SHARE ${shareName} REMOVE ACCOUNT = ${receiver};`;

  connection.execute({
    sqlText: sql,
    complete: (err) => {
      if (err) {
        console.error('❌ Error removing account:', err.message);
        return res.status(500).send('Error removing account: ' + err.message);
      }
      res.send(`✅ Account ${receiver} removed from share ${shareName}.`);
    }
  });
});


// module.exports = router;
// -------------------- SERVER START --------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
