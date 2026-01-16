const express = require('express');
const { Client } = require('ssh2');
const path = require('path');

const app = express();
const port = 8091;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, '../public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// SSH command execution
async function executeSSHCommand(host, username, password, sshPort, command) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let output = '';
    let errorOutput = '';

    conn.on('ready', () => {
      console.log(`✓ Connected to ${host}`);
      console.log(`  Executing: ${command.substring(0, 100)}...`);
      
      conn.exec(command, (err, stream) => {
        if (err) {
          conn.end();
          return reject({ success: false, error: `Command error: ${err.message}` });
        }

        stream.on('close', (code, signal) => {
          console.log(`✓ Command completed with exit code: ${code}`);
          conn.end();
          resolve({ 
            success: code === 0, 
            output: output,
            errorOutput: errorOutput,
            exitCode: code 
          });
        }).on('data', (data) => {
          output += data.toString();
        }).stderr.on('data', (data) => {
          errorOutput += data.toString();
        });
      });
    }).on('error', (err) => {
      console.error(`SSH Error: ${err.message}`);
      reject({ success: false, error: `Connection error: ${err.message}` });
    }).connect({
      host: host,
      port: sshPort || 22,
      username: username,
      password: password,
      readyTimeout: 30000,
      keepaliveInterval: 10000
    });
  });
}

// Parse ws.sh -showInfo output to find ws-tsdb VM IP
function parseWSDBIPAddress(output) {
  const lines = output.split('\n');
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Look for ws-tsdb in the line
    if (line.includes('ws-tsdb')) {
      // Try to extract IP address from the line or surrounding lines
      // Common pattern: IP address format (xxx.xxx.xxx.xxx)
      const ipPattern = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
      
      // Check current line
      const match = line.match(ipPattern);
      if (match && match.length > 0) {
        return match[0];
      }
      
      // Check previous lines for IP address
      for (let j = i - 1; j >= Math.max(0, i - 5); j--) {
        const prevMatch = lines[j].match(ipPattern);
        if (prevMatch && prevMatch.length > 0) {
          return prevMatch[0];
        }
      }
    }
  }
  
  return null;
}

// Home page
app.get('/', (req, res) => {
  res.render('Pinot_GUI_Login');
});

// Deploy TCP Proxy
app.post('/deploy', async (req, res) => {
  const { vmIP, username, password, port } = req.body;
  
  console.log('\n========================================');
  console.log('TCP Proxy Deployment Started');
  console.log('========================================');
  console.log(`Initial VM: ${vmIP}:${port || 22}`);
  console.log(`User: ${username}`);
  
  const steps = [];
  
  try {
    // Step 1: Connect to initial VM and run ws.sh -showInfo
    steps.push({ step: 1, action: 'Connecting to initial VM', status: 'in-progress' });
    
    const wsResult = await executeSSHCommand(vmIP, username, password, parseInt(port) || 22, 'ws.sh -showInfo');
    
    if (!wsResult.success) {
      steps[0].status = 'failed';
      steps[0].error = wsResult.error || wsResult.errorOutput;
      return res.json({ success: false, steps, error: 'Failed to execute ws.sh -showInfo' });
    }
    
    steps[0].status = 'completed';
    steps[0].output = wsResult.output.substring(0, 500) + '...';
    
    // Step 2: Parse output to find ws-tsdb IP
    steps.push({ step: 2, action: 'Searching for ws-tsdb component', status: 'in-progress' });
    
    const wstsdbIP = parseWSDBIPAddress(wsResult.output);
    
    if (!wstsdbIP) {
      steps[1].status = 'failed';
      steps[1].error = 'Could not find ws-tsdb IP address in output';
      return res.json({ success: false, steps, error: 'ws-tsdb not found in output', fullOutput: wsResult.output });
    }
    
    steps[1].status = 'completed';
    steps[1].result = `Found ws-tsdb VM IP: ${wstsdbIP}`;
    
    console.log(`✓ Found ws-tsdb VM: ${wstsdbIP}`);
    
    // Step 3: Connect to ws-tsdb VM and deploy
    steps.push({ step: 3, action: `Connecting to ws-tsdb VM (${wstsdbIP})`, status: 'in-progress' });
    
    const deployCommands = [
      'curl -O http://135.250.143.187:8090/tcpproxy.tar.gz',
      'docker load -i tcpproxy.tar.gz',
      'docker stop pinottcpproxy || true',
      'docker rm pinottcpproxy || true',
      'sudo docker create --name pinottcpproxy --hostname pinottcpproxy -p 9444:9444 --env PROXY_PORT=9444 --env DATABASE_ADDRESS=ws-tsdb:9443 --network nfmt-net 135.250.140.175:5000/tcp_proxy_nfmt',
      'docker start pinottcpproxy'
    ].join(' && ');
    
    const deployResult = await executeSSHCommand(wstsdbIP, username, password, parseInt(port) || 22, deployCommands);
    
    if (!deployResult.success) {
      steps[2].status = 'failed';
      steps[2].error = deployResult.error || deployResult.errorOutput;
      steps[2].output = deployResult.output;
      return res.json({ success: false, steps, error: 'Deployment commands failed' });
    }
    
    steps[2].status = 'completed';
    steps[2].output = deployResult.output;
    
    console.log('✓ TCP Proxy deployed successfully');
    console.log('========================================\n');
    
    res.json({ 
      success: true, 
      steps,
      wstsdbIP,
      message: `TCP Proxy successfully deployed on ${wstsdbIP}`
    });
    
  } catch (error) {
    console.error('Deployment error:', error);
    res.json({ 
      success: false, 
      steps,
      error: error.message || 'Deployment failed' 
    });
  }
});

app.listen(port, () => {
  console.log('\n========================================');
  console.log('Pinot GUI Login');
  console.log(`Server running at http://localhost:${port}`);
  console.log('========================================\n');
});
