<?php
/**
 * Standalone compatibility tests for Bridge security primitives.
 *
 * Run with PHP 7.4+; WordPress functions used by security.php are stubbed
 * narrowly so the lint and filesystem gates can be exercised without a site.
 */

declare( strict_types = 1 );

$test_root = sys_get_temp_dir() . '/chinvat-bridge-test-' . getmypid() . '-' . bin2hex( random_bytes( 3 ) );
$theme_dir = $test_root . '/theme';
$content_dir = $test_root . '/content';
mkdir( $theme_dir, 0777, true );
mkdir( $content_dir, 0777, true );

define( 'ABSPATH', $test_root . '/' );
define( 'WP_CONTENT_DIR', $content_dir );
define( 'CHINVAT_BRIDGE_VERSION', '0.4.3' );
define( 'CHINVAT_BRIDGE_SCHEMA_VERSION', 4 );
define( 'CHINVAT_BRIDGE_REST_NS', 'chinvat-bridge/v1' );

$GLOBALS['chinvat_test_theme_dir'] = $theme_dir;

class WP_Error {
	private $code;
	private $message;
	private $data;

	public function __construct( $code = '', $message = '', $data = null ) {
		$this->code = $code;
		$this->message = $message;
		$this->data = $data;
	}

	public function get_error_code() {
		return $this->code;
	}

	public function get_error_message() {
		return $this->message;
	}

	public function get_error_data() {
		return $this->data;
	}
}

class WP_REST_Response {
	private $data;
	private $status;

	public function __construct( $data = null, $status = 200 ) {
		$this->data = $data;
		$this->status = $status;
	}

	public function get_data() {
		return $this->data;
	}

	public function get_status() {
		return $this->status;
	}
}

function __( $text, $domain = null ) {
	return $text;
}

function is_wp_error( $value ): bool {
	return $value instanceof WP_Error;
}

function apply_filters( $hook, $value ) {
	return $value;
}

function wp_normalize_path( $path ): string {
	return str_replace( '\\', '/', (string) $path );
}

function get_stylesheet_directory(): string {
	return $GLOBALS['chinvat_test_theme_dir'];
}

function get_stylesheet(): string {
	return 'chinvat-test-theme';
}

function get_template(): string {
	return 'chinvat-test-theme';
}

function get_theme_root(): string {
	return dirname( $GLOBALS['chinvat_test_theme_dir'] );
}

function wp_tempnam( $filename = '' ) {
	return tempnam( sys_get_temp_dir(), 'chinvat-lint-' );
}

function trailingslashit( $path ): string {
	return rtrim( (string) $path, '/\\' ) . '/';
}

function wp_mkdir_p( $target ): bool {
	return is_dir( $target ) || @mkdir( $target, 0777, true );
}

function wp_rand( $min, $max ): int {
	return random_int( (int) $min, (int) $max );
}

require dirname( __DIR__ ) . '/includes/security.php';
require dirname( __DIR__ ) . '/includes/rest-info.php';

$failures = array();
$checks = 0;

function chinvat_test_check( $condition, string $label ): void {
	global $checks, $failures;
	++$checks;
	if ( ! $condition ) {
		$failures[] = $label;
	}
}

function chinvat_test_error_code( $value ): string {
	return is_wp_error( $value ) ? (string) $value->get_error_code() : '';
}

function chinvat_test_remove_tree( string $path ): void {
	if ( ! is_dir( $path ) ) {
		@unlink( $path );
		return;
	}
	$items = scandir( $path );
	if ( false !== $items ) {
		foreach ( $items as $item ) {
			if ( '.' === $item || '..' === $item ) {
				continue;
			}
			chinvat_test_remove_tree( $path . '/' . $item );
		}
	}
	@rmdir( $path );
}

$mode = isset( $argv[1] ) ? (string) $argv[1] : 'default';

if ( 'backup-failure' === $mode ) {
	file_put_contents( WP_CONTENT_DIR . '/chinvat-bak', 'blocks-directory-creation' );
	$source = $theme_dir . '/functions.php';
	file_put_contents( $source, "<?php\n" );
	$result = chinvat_bridge_backup( $source );
	chinvat_test_check( 'chinvat_backup_dir' === chinvat_test_error_code( $result ), 'backup directory failure must return chinvat_backup_dir' );
} else {
	$expected = function_exists( 'token_get_all' ) && defined( 'TOKEN_PARSE' )
		? 'zend-tokenizer'
		: ( function_exists( 'proc_open' ) && '' !== chinvat_bridge_php_cli_binary() ? 'php-cli' : 'unavailable' );

	chinvat_test_check( $expected === chinvat_bridge_php_lint_backend(), 'backend selection must match available runtime primitives' );

	$valid = "<?php\n// فروشگاه سه‌بعدی\nfunction chinvat_test_valid() { return 'درست'; }\n";
	$valid_result = chinvat_bridge_php_lint( $theme_dir . '/functions.php', $valid );
	if ( 'unavailable' === $expected ) {
		chinvat_test_check( 'chinvat_no_lint' === chinvat_test_error_code( $valid_result ), 'missing backends must fail closed' );
	} else {
		$valid_detail = is_wp_error( $valid_result )
			? chinvat_test_error_code( $valid_result ) . ':' . json_encode( $valid_result->get_error_data() )
			: var_export( $valid_result, true );
		chinvat_test_check( $expected === $valid_result, 'valid UTF-8 PHP must return the selected backend; got ' . $valid_detail );
	}

	$invalid_result = chinvat_bridge_php_lint( $theme_dir . '/functions.php', "<?php\nfunction broken( {\n" );
	if ( 'unavailable' === $expected ) {
		chinvat_test_check( 'chinvat_no_lint' === chinvat_test_error_code( $invalid_result ), 'unavailable backend must report chinvat_no_lint' );
	} else {
		chinvat_test_check( 'chinvat_lint_failed' === chinvat_test_error_code( $invalid_result ), 'malformed PHP must be rejected' );
		$data = $invalid_result->get_error_data();
		chinvat_test_check( is_array( $data ) && $expected === $data['backend'], 'lint error must identify its backend' );
	}

	chinvat_test_check( 'not-applicable' === chinvat_bridge_php_lint( $theme_dir . '/style.css', 'body{}' ), 'non-PHP files must bypass PHP linting explicitly' );

	$info = chinvat_bridge_php_lint_info();
	chinvat_test_check( $expected === $info['backend'], 'diagnostics must report the selected backend' );
	chinvat_test_check( PHP_VERSION === $info['runtime_version'], 'diagnostics must report the executing PHP version' );
	chinvat_test_check( ( 'unavailable' !== $expected ) === $info['available'], 'diagnostic availability must match backend state' );
	$response = chinvat_bridge_info_response();
	$response_data = $response->get_data();
	chinvat_test_check( 4 === $response_data['schema_version'], 'bridge_info must report schema 4' );
	chinvat_test_check( $expected === $response_data['php_lint']['backend'], 'bridge_info must expose live PHP lint diagnostics' );

	$atomic_target = $theme_dir . '/atomic.php';
	$atomic_result = chinvat_bridge_atomic_write( $atomic_target, $valid );
	chinvat_test_check( strlen( $valid ) === $atomic_result, 'atomic writer must report exact bytes' );
	chinvat_test_check( $valid === file_get_contents( $atomic_target ), 'atomic writer must preserve UTF-8 bytes' );

	$blocked_target = $theme_dir . '/blocked.php';
	mkdir( $blocked_target );
	$blocked_result = chinvat_bridge_atomic_write( $blocked_target, $valid );
	chinvat_test_check( 'chinvat_not_regular' === chinvat_test_error_code( $blocked_result ), 'atomic writer must reject non-regular targets' );

	$backup_result = chinvat_bridge_backup( $atomic_target );
	chinvat_test_check( is_string( $backup_result ) && is_file( $backup_result ), 'backup must be created before replacement' );
	chinvat_test_check( $valid === file_get_contents( $backup_result ), 'backup must preserve source bytes' );

	$abilities = file_get_contents( dirname( __DIR__ ) . '/includes/abilities.php' );
	$lint_pos = strpos( $abilities, 'chinvat_bridge_php_lint( $abs, $content )' );
	$backup_pos = strpos( $abilities, 'chinvat_bridge_backup( $abs )' );
	$write_pos = strpos( $abilities, 'chinvat_bridge_atomic_write( $abs, $content )' );
	chinvat_test_check( false !== $lint_pos && $lint_pos < $backup_pos && $backup_pos < $write_pos, 'theme-write order must remain lint, backup, atomic write' );
	chinvat_test_check( false !== strpos( $abilities, "'lint_backend' => (string) \$lint" ), 'theme-write must return the lint backend' );

}

chinvat_test_remove_tree( $test_root );

if ( $failures ) {
	fwrite( STDERR, 'FAIL (' . count( $failures ) . '/' . $checks . ")\n- " . implode( "\n- ", $failures ) . "\n" );
	exit( 1 );
}

echo 'PASS ' . $mode . ' (' . $checks . ' checks) on PHP ' . PHP_VERSION . "\n";
