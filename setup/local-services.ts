import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { logger } from '../src/logger.js';
import { getPlatform } from './platform.js';

interface LocalService {
  name: string;
  command: string;
  keepAlive?: boolean;
  runAtLoad?: boolean;
  workingDirectory?: string;
  env?: Record<string, string>;
}

export async function run(_args: string[]): Promise<void> {
  const projectRoot = process.cwd();
  const platform = getPlatform();
  const homeDir = os.homedir();

  if (platform !== 'macos') {
    logger.error('local-services is currently only supported on macOS');
    process.exit(1);
  }

  const servicesPath = path.join(projectRoot, 'local-services.json');
  if (!fs.existsSync(servicesPath)) {
    logger.info('No local-services.json found, skipping.');
    return;
  }

  const services: LocalService[] = JSON.parse(fs.readFileSync(servicesPath, 'utf-8'));
  logger.info({ count: services.length }, 'Setting up local services');

  for (const service of services) {
    setupService(service, projectRoot, homeDir);
  }
}

function setupService(
  service: LocalService,
  projectRoot: string,
  homeDir: string,
): void {
  const plistName = `com.nanoclaw.${service.name}.plist`;
  const plistPath = path.join(homeDir, 'Library', 'LaunchAgents', plistName);
  const logDir = path.join(projectRoot, 'logs', 'services');
  fs.mkdirSync(logDir, { recursive: true });

  const commandParts = service.command.split(' ');
  const program = commandParts[0];
  const args = commandParts.slice(1);

  const envVars = {
    PATH: '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:' + path.join(homeDir, '.local/bin'),
    HOME: homeDir,
    ...service.env,
  };

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.nanoclaw.${service.name}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${program}</string>
        ${args.map(arg => `<string>${arg}</string>`).join('\n        ')}
    </array>
    <key>WorkingDirectory</key>
    <string>${service.workingDirectory || projectRoot}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>EnvironmentVariables</key>
    <dict>
        ${Object.entries(envVars)
          .map(([k, v]) => `<key>${k}</key>\n        <string>${v}</string>`)
          .join('\n        ')}
    </dict>
    <key>StandardOutPath</key>
    <string>${logDir}/${service.name}.log</string>
    <key>StandardErrorPath</key>
    <string>${logDir}/${service.name}.error.log</string>
</dict>
</plist>`;

  fs.writeFileSync(plistPath, plist);
  logger.info({ service: service.name, plistPath }, 'Wrote service plist');

  try {
    // Unload first if already loaded to apply changes
    execSync(`launchctl unload ${JSON.stringify(plistPath)} 2>/dev/null || true`);
    execSync(`launchctl load ${JSON.stringify(plistPath)}`);
    logger.info({ service: service.name }, 'Service loaded successfully');
  } catch (err) {
    logger.error({ service: service.name, err }, 'Failed to load service');
  }
}
