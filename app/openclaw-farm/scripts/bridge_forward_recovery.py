"""Recover only the current instance's recorded, verified managed SSH process."""
import time
import private_storage as storage


def recover_forward(instance_id, registry, farm):
    record = farm.get_record(registry, instance_id)
    bridge = farm.get_bridge_record(record)
    if bridge.get('transport') != 'ssh_relay':
        raise farm.FarmError('当前实例不是 SSH 中继连接。')
    port = int(bridge['local_port'])
    owners = [key for key, row in registry['instances'].items()
              if int((row.get('file_bridge') or {}).get('local_port') or 0) == port]
    if owners != [instance_id]:
        raise farm.FarmError('本地端口被多个实例登记，未中断任何连接；请核对独立隧道端口。')
    with storage.file_lock(farm.adapter_state_dir() / f'relay-forward-{port}.lock'):
        managed = farm.managed_forward_record(bridge)
        if farm.port_open('127.0.0.1', port):
            if not managed or not storage.stop_owned(managed):
                raise farm.FarmError('该端口没有可验证的本管理台进程记录，未中断其他连接。')
            deadline = time.monotonic() + 5
            while farm.port_open('127.0.0.1', port) and time.monotonic() < deadline:
                time.sleep(.1)
            if farm.port_open('127.0.0.1', port):
                raise farm.FarmError('原转发尚未释放端口，未建立重复连接。')
    farm.ensure_local_bridge_forward(bridge)
    return farm.bridge_health(instance_id, record)
