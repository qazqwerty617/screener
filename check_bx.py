import paramiko
ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('169.58.138.33', username='root', password='AQwaffwedcv', timeout=10)
stdin, stdout, stderr = ssh.exec_command('curl -s "http://127.0.0.1:3000/api/klines?ex=BX&sym=MMT-USDT&tf=4h&lite=1"')
res = stdout.read().decode('utf-8')
print("Status length:", len(res))
print("Sample:", res[:300])

stdin, stdout, stderr = ssh.exec_command('curl -s "http://127.0.0.1:3000/api/klines?ex=BX&sym=MMT-USDT&tf=4h&lite=0"')
res2 = stdout.read().decode('utf-8')
print("Full Status length:", len(res2))
print("Full Sample:", res2[:300])

ssh.close()
