const dns = require('dns/promises')
const net = require('net')

/**
 * Retrieves the status of a minecraft server.
 * 
 * @param {string} address The server address.
 * @param {number} port Optional. The port of the server. Defaults to 25565.
 * @returns {Promise.<Object>} A promise which resolves to an object containing
 * status information.
 */
exports.getStatus = function(address, port = 25565){

    if(port == null || port == ''){
        port = 25565
    }
    if(typeof port === 'string'){
        port = parseInt(port)
    }

    return new Promise((resolve, reject) => {
        const socket = net.connect(port, address, () => {
            let buff = Buffer.from([0xFE, 0x01])
            socket.write(buff)
        })

        socket.setTimeout(2500, () => {
            socket.end()
            reject({
                code: 'ETIMEDOUT',
                errno: 'ETIMEDOUT',
                address,
                port
            })
        })

        socket.on('data', (data) => {
            if(data != null && data != ''){
                let server_info = data.toString().split('\x00\x00\x00')
                const NUM_FIELDS = 6
                if(server_info != null && server_info.length >= NUM_FIELDS){
                    resolve({
                        online: true,
                        version: server_info[2].replace(/\u0000/g, ''),
                        motd: server_info[3].replace(/\u0000/g, ''),
                        onlinePlayers: server_info[4].replace(/\u0000/g, ''),
                        maxPlayers: server_info[5].replace(/\u0000/g,'')
                    })
                } else {
                    resolve({
                        online: false
                    })
                }
            }
            socket.end()
        })

        socket.on('error', (err) => {
            socket.destroy()
            reject(err)
            // ENOTFOUND = Unable to resolve.
            // ECONNREFUSED = Unable to connect to port.
        })
    })

}
function varInt(n){
    const out = []
    do {
        let b = n & 0x7F
        n >>>= 7
        if(n !== 0) b |= 0x80
        out.push(b)
    } while(n !== 0)
    return Buffer.from(out)
}

/** Reads a VarInt at `off`; null while the buffer does not hold all of it yet. */
function readVarInt(buf, off){
    let n = 0
    for(let i = 0; i < 5; i++){
        if(off + i >= buf.length) return null
        const b = buf[off + i]
        n |= (b & 0x7F) << (7 * i)
        if((b & 0x80) === 0) return { value: n >>> 0, size: i + 1 }
    }
    throw new Error('VarInt too long')
}

function packet(...parts){
    const body = Buffer.concat(parts)
    return Buffer.concat([varInt(body.length), body])
}

/**
 * A modern Server List Ping (1.7+), following the server's SRV record. Unlike helios-core's
 * getServerStatus it reads until the whole response has arrived however many chunks that takes:
 * a server with an icon answers with ~15 KB, which helios gives up on after five reads.
 *
 * @param {string} hostname
 * @param {number} [port=25565]
 * @param {number} [timeout=5000]
 * @returns {Promise<Object>} The status JSON (description, players, version, …).
 */
exports.ping = async function(hostname, port = 25565, timeout = 5000){
    try {
        const [srv] = await dns.resolveSrv(`_minecraft._tcp.${hostname}`)
        if(srv){ hostname = srv.name; port = srv.port }
    } catch { /* no SRV record: connect as given */ }

    return new Promise((resolve, reject) => {
        let buf = Buffer.alloc(0)
        const socket = net.connect(port, hostname, () => {
            const host = Buffer.from(hostname, 'utf8')
            const portBuf = Buffer.alloc(2)
            portBuf.writeUInt16BE(port)
            socket.write(packet(varInt(0x00), varInt(47), varInt(host.length), host, portBuf, varInt(1)))
            socket.write(packet(varInt(0x00)))
        })
        const fail = err => { socket.destroy(); reject(err) }
        socket.setTimeout(timeout, () => fail(new Error(`Status ping of ${hostname}:${port} timed out`)))
        socket.on('error', fail)
        socket.on('data', data => {
            buf = Buffer.concat([buf, data])
            try {
                const len = readVarInt(buf, 0)
                if(!len || buf.length < len.size + len.value) return
                let off = len.size
                const id = readVarInt(buf, off)
                if(id.value !== 0x00) return fail(new Error(`Unexpected status packet ${id.value}`))
                off += id.size
                const str = readVarInt(buf, off)
                off += str.size
                const json = JSON.parse(buf.toString('utf8', off, off + str.value))
                socket.end()
                resolve(json)
            } catch(err) {
                fail(err)
            }
        })
    })
}
