import paramiko
import os
import sys

sys.stdout.reconfigure(encoding='utf-8')

# Load credentials from .env
def load_env(path=".env"):
    env = {}
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    env[k.strip()] = v.strip()
    except FileNotFoundError:
        pass
    return env

_env = load_env(os.path.join(os.path.dirname(__file__), ".env"))
hostname = _env.get("DEPLOY_HOST", os.environ.get("DEPLOY_HOST", ""))
username = _env.get("DEPLOY_USER", os.environ.get("DEPLOY_USER", "root"))
password = _env.get("DEPLOY_PASSWORD", os.environ.get("DEPLOY_PASSWORD", ""))
remote_bases = ["/root/nother", "/root/cryptoscreen"]
local_base = os.path.abspath(".")
local_env_path = os.path.join(local_base, "node-server", ".env")

ignore_dirs = {".git", ".vscode", "node_modules", "scratch", "knowledge", "__pycache__"}
ignore_files = {
    ".env",  # never upload credentials to server
    "remote_inspect.py", "deploy.py", "check_remote.py", "check_remote2.py",
    "sessions.json", "users.json", "auth_logs.json", "payments.json",
    "promos.json", "support.json", "bug_reports.json", "admin_audit.json",
    "admin_settings.json"
}

def sftp_mkdir_p(sftp, remote_directory):
    dirs = []
    dir_path = remote_directory
    while dir_path and dir_path != "/":
        dirs.append(dir_path)
        dir_path = os.path.dirname(dir_path)
    dirs.reverse()

    for d in dirs:
        try:
            sftp.stat(d)
        except IOError:
            try:
                sftp.mkdir(d)
            except Exception as e:
                pass

def deploy():
    print(f"Connecting to {hostname}...")
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh.connect(hostname, username=username, password=password, timeout=15)
    print("SSH Connected!")

    sftp = ssh.open_sftp()

    for remote_base in remote_bases:
        print(f"\n--- Deploying to {remote_base} ---")
        uploaded_count = 0

        for root, dirs, files in os.walk(local_base):
            dirs[:] = [d for d in dirs if d not in ignore_dirs]

            rel_path = os.path.relpath(root, local_base)
            if rel_path == ".":
                remote_dir = remote_base
            else:
                remote_dir = os.path.join(remote_base, rel_path).replace("\\", "/")

            sftp_mkdir_p(sftp, remote_dir)

            for file_name in files:
                if file_name in ignore_files or file_name.endswith(".pyc"):
                    continue

                local_file = os.path.join(root, file_name)
                remote_file = os.path.join(remote_dir, file_name).replace("\\", "/")

                local_mtime = os.path.getmtime(local_file)
                local_size = os.path.getsize(local_file)

                # Skip uploading if remote file exists and is identical in mtime & size
                try:
                    rstat = sftp.stat(remote_file)
                    if abs(rstat.st_mtime - local_mtime) < 2 and rstat.st_size == local_size:
                        continue
                except IOError:
                    pass

                print(f"Uploading {os.path.relpath(local_file, local_base)} -> {remote_file}...")
                sftp.put(local_file, remote_file)
                try:
                    sftp.utime(remote_file, (local_mtime, local_mtime))
                except Exception:
                    pass
                uploaded_count += 1

        print(f"Uploaded {uploaded_count} updated files to {remote_base}!")

    # Remove root-level .env if accidentally uploaded
    print("\nCleaning up root .env from remote servers...")
    for remote_base in remote_bases:
        stdin, stdout, stderr = ssh.exec_command(f"rm -f {remote_base}/.env")
        stdout.read()
        print(f"  Removed {remote_base}/.env")

    # Upload node-server/.env to each remote (without displaying contents)
    print("\nUploading node-server/.env to remote servers...")
    if os.path.exists(local_env_path):
        for remote_base in remote_bases:
            remote_env = f"{remote_base}/node-server/.env"
            sftp.put(local_env_path, remote_env)
            sftp.chmod(remote_env, 0o600)  # owner-only read/write
            print(f"  .env -> {remote_env} (chmod 600)")
    else:
        print("  WARNING: node-server/.env not found locally — skipping upload!")
        print("  Create node-server/.env and fill in your tokens before deploying.")

    sftp.close()

    print("\nRestarting PM2 processes with fresh environment...")
    stdin, stdout, stderr = ssh.exec_command("cd /root/nother/node-server && pm2 restart all --update-env && pm2 status")
    out = stdout.read().decode('utf-8', errors='ignore')
    err = stderr.read().decode('utf-8', errors='ignore')
    print("=== PM2 Output ===")
    print(out)
    if err:
        print("=== PM2 Errors ===")
        print(err)

    ssh.close()
    print("Deployment finished successfully to /root/nother!")

if __name__ == "__main__":
    deploy()
