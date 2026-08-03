<?php
// Reject anything that isn't a POST
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    header('Location: /');
    exit;
}

// Honeypot — bots fill this, humans don't
if (!empty($_POST['website'])) {
    header('Location: /');
    exit;
}

$name        = trim(strip_tags($_POST['name']        ?? ''));
$email       = trim(strip_tags($_POST['email']       ?? ''));
$institution = trim(strip_tags($_POST['institution'] ?? ''));
$topic       = trim(strip_tags($_POST['topic']       ?? 'Peer Review & Scientific Evaluation'));
$message     = trim(strip_tags($_POST['message']     ?? ''));

// Validate
if (
    empty($name) ||
    empty($email) ||
    empty($institution) ||
    empty($message) ||
    !filter_var($email, FILTER_VALIDATE_EMAIL)
) {
    header('Location: /?error=1');
    exit;
}

$to        = 'support@meetfleet.app';
$ticket_id = '#PR-' . strtoupper(substr(md5(uniqid(rand(), true)), 0, 6));
$subject   = '[Peer Review ' . $ticket_id . '] ' . $topic . ' — ' . $name;
$timestamp = date('M j, Y \a\t g:i A T');
$first_name = explode(' ', $name)[0];

$topic_class = 'topic-science';
$topic_icon  = '🔬';

$template = file_get_contents(__DIR__ . '/email-template.html');

if ($template === false) {
    // Fallback plain text email if template file fails to load
    $body  = "Name:        $name\n";
    $body .= "Email:       $email\n";
    if (!empty($institution)) {
        $body .= "Institution: $institution\n";
    }
    $body .= "Topic:       $topic\n";
    $body .= "Ticket:      $ticket_id\n";
    $body .= "Submitted:   $timestamp\n";
    $body .= str_repeat('-', 40) . "\n\n";
    $body .= $message . "\n";

    $headers  = "From: Meetfleet Scientific <support@meetfleet.app>\r\n";
    $headers .= "Reply-To: $name <$email>\r\n";
    $headers .= "Content-Type: text/plain; charset=UTF-8\r\n";
    $headers .= "X-Mailer: PHP/" . phpversion() . "\r\n";
} else {
    // Replace template variables
    $body = str_replace(
        ['{{TICKET_ID}}', '{{NAME}}', '{{FIRST_NAME}}', '{{EMAIL}}', '{{INSTITUTION}}', '{{TOPIC_NAME}}', '{{TOPIC_CLASS}}', '{{TOPIC_ICON}}', '{{TOPIC_ENCODED}}', '{{TIMESTAMP}}', '{{MESSAGE}}'],
        [$ticket_id, htmlspecialchars($name), htmlspecialchars($first_name), htmlspecialchars($email), htmlspecialchars($institution), htmlspecialchars($topic), $topic_class, $topic_icon, urlencode($topic), $timestamp, nl2br(htmlspecialchars($message))],
        $template
    );

    $headers  = "From: Meetfleet Scientific <support@meetfleet.app>\r\n";
    $headers .= "Reply-To: $name <$email>\r\n";
    $headers .= "MIME-Version: 1.0\r\n";
    $headers .= "Content-Type: text/html; charset=UTF-8\r\n";
    $headers .= "X-Mailer: PHP/" . phpversion() . "\r\n";
}

$extra = '-f support@meetfleet.app';

if (mail($to, $subject, $body, $headers, $extra)) {
    header('Location: /success/');
    exit;
}

// Log failure
error_log('[Meetfleet Peer Review] mail() failed for: ' . $email);
header('Location: /?error=1');
exit;
