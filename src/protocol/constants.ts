/** ET wire protocol constants, verified against EternalTerminal @ PROTOCOL_VERSION 6. */

export const PROTOCOL_VERSION = 6

/** Packet header bytes. Sending anything else makes the remote abort (STFATAL). */
export enum ETPacketType {
    KEEP_ALIVE = 0,
    TERMINAL_BUFFER = 1,
    TERMINAL_INFO = 2,
    PORT_FORWARD_DESTINATION_REQUEST = 5,
    PORT_FORWARD_DESTINATION_RESPONSE = 6,
    PORT_FORWARD_DATA = 7,
    // 8, 9, 10 are etserver <-> etterminal only and never appear on TCP
    INITIAL_RESPONSE = 252,
    INITIAL_PAYLOAD = 253,
}

export enum ETConnectStatus {
    NEW_CLIENT = 1,
    RETURNING_CLIENT = 2,
    INVALID_KEY = 3,
    MISMATCHED_PROTOCOL = 4,
}

/** Nonce discriminator: the LAST byte of the 24-byte nonce. */
export const CLIENT_SERVER_NONCE_MSB = 0
export const SERVER_CLIENT_NONCE_MSB = 1

/** Serialized Packet = [encrypted:u8][header:u8][payload...] */
export const PACKET_HEADER_SIZE = 2

/** Length caps enforced by etserver; we enforce them too, defensively. */
export const MAX_PROTO_LENGTH = 128 * 1024 * 1024
export const MAX_HANDSHAKE_PROTO_LENGTH = 4 * 1024

/**
 * BackedWriter buffer limits, matching ET.
 *
 * MAX_BACKUP_BYTES is how much that has been sent is kept for replay.
 * DISCONNECT_BUFFER_BYTES is how much may be waiting to be sent at all - in
 * ET only while disconnected, here at any time, since our writes never block.
 * Together with what is lost in transit they have to stay under
 * MAX_PROTO_LENGTH, which is the largest catch-up etserver will accept.
 */
export const MAX_BACKUP_BYTES = 64 * 1024 * 1024
export const DISCONNECT_BUFFER_BYTES = 64 * 1024 * 1024

/**
 * Room kept past DISCONNECT_BUFFER_BYTES for messages that must not be lost:
 * the ones that say a tunnelled connection is over, or could not be made. A
 * peer that never hears of it keeps its end open for as long as the session
 * lasts. They are a few dozen bytes each; anything larger is data, whatever it
 * is sent as.
 */
export const CONTROL_RESERVE_BYTES = 1024 * 1024
export const MAX_CONTROL_MESSAGE_BYTES = 4 * 1024

/**
 * How much may be waiting to go out before whoever is producing it is asked to
 * hold on. The reference client gets this for free: its writes block. Ours
 * never do, so without a limit a local application feeding a tunnel is read at
 * memory speed, all of it is queued, and the replay buffer - which only keeps
 * the newest MAX_BACKUP_BYTES - ends up trimming packets that have not even
 * been sent yet. A reconnect after that cannot be recovered from.
 */
export const WRITE_HIGH_WATER_MARK = 4 * 1024 * 1024

/**
 * How long packets that are already here are read in one go, in ms, before
 * everything else is given a turn. A replay can be a hundred thousand packets
 * long, and reading one takes no waiting: without a limit nothing is drawn,
 * no key is taken and no timer fires until the last of them has been read.
 */
export const READ_SLICE_MS = 8

/** ET reads/writes the PTY in 16 KiB chunks. */
export const TERMINAL_CHUNK_SIZE = 16 * 1024

/** Port-forward payload chunk size. ET uses 1 KiB; any size is valid. */
export const PORT_FORWARD_CHUNK_SIZE = 16 * 1024

export const DEFAULT_ET_PORT = 2022

/** Timeouts (ms). */
export const HANDSHAKE_TIMEOUT = 30000
export const INITIAL_RESPONSE_TIMEOUT = 10000
/**
 * How long a server that was sent a catch-up is given to answer, before a
 * link that says nothing is given up. It cannot answer before it has all of
 * the catch-up, and what has left us may still be a long way from there.
 */
export const CATCHUP_ANSWER_TIMEOUT = 30000
/**
 * The most that it is given. Each time a link is given up with a catch-up
 * still unanswered, the next one is given twice as long: on a link that
 * carries anything at all, a catch-up arrives in the end.
 */
export const MAX_CATCHUP_ANSWER_TIMEOUT = 16 * 60 * 1000
export const RECONNECT_INTERVAL = 1000
/**
 * How long a first connection through a jump host goes on asking when it is
 * told that its key is not known, and how long it waits between two tries.
 * The jump host learns the key only after etterminal has said that it is
 * ready, so that the first answer can come before the key is known.
 */
export const JUMP_REGISTRATION_GRACE = 5000
export const JUMP_REGISTRATION_RETRY = 250
export const PING_TIMEOUT = 5000
/** TCP connect timeout for the initial connection and every reconnect attempt. */
export const CONNECT_TIMEOUT = 10000

/**
 * etterminal splits the bootstrap line on '_', so TERM must not contain one.
 * This is not configurable on purpose. See ETERNAL_TERMINAL.md D8.
 */
export const ET_TERM = 'xterm-256color'
