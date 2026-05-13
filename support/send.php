<?php
// Reject anything that isn't a POST
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    header('Location: /support/');
    exit;
}

// Honeypot — bots fill this, humans don't
if (!empty($_POST['website'])) {
    header('Location: /support/');
    exit;
}

$name    = trim(strip_tags($_POST['name']    ?? ''));
$email   = trim(strip_tags($_POST['email']   ?? ''));
$topic   = trim(strip_tags($_POST['topic']   ?? 'General'));
$message = trim(strip_tags($_POST['message'] ?? ''));

// Validate
if (
    empty($name) ||
    empty($email) ||
    empty($message) ||
    !filter_var($email, FILTER_VALIDATE_EMAIL)
) {
    header('Location: /support/?error=1');
    exit;
}

$to      = 'support@meetfleet.app';
$subject = '[Support] ' . $topic . ' — ' . $name;

$body  = "Name:    $name\n";
$body .= "Email:   $email\n";
$body .= "Topic:   $topic\n";
$body .= str_repeat('-', 40) . "\n\n";
$body .= $message . "\n";

$headers  = "From: noreply@meetfleet.app\r\n";
$headers .= "Reply-To: $email\r\n";
$headers .= "Content-Type: text/plain; charset=UTF-8\r\n";
$headers .= "X-Mailer: PHP/" . phpversion() . "\r\n";

if (mail($to, $subject, $body, $headers)) {
    header('Location: /support/success/');
} else {
    header('Location: /support/?error=1');
}
exit;
